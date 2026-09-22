/**
 * @hidden
 * JS source injected into every frame of a recorded page via
 * Page.addScriptToEvaluateOnNewDocument (plus a one-shot Runtime.evaluate
 * for the already-loaded page when recording starts). Capture-phase
 * listeners forward core interactions through the CDP binding
 * __tabbyWvReport (Runtime.addBinding → Runtime.bindingCalled).
 *
 * Constraints:
 * - runs in the page's main world, before page CSP evaluation — no CSP issue
 * - idempotent (both injection paths can fire for one document) and silent
 *   when the binding is absent (recorder detached: events are dropped)
 * - payload caps keep every message under ~1KB (selector 120, snippet 80,
 *   value 200); password fields are masked HERE, unconditionally
 * - String.raw keeps every backslash verbatim — this is page-side code, not
 *   TypeScript-processed source
 */
export const INJECTED_SCRIPT_SOURCE = String.raw`(function () {
    'use strict';
    if (window.__tabbyWvInstalled) { return; }
    window.__tabbyWvInstalled = true;

    var COALESCE_MS = 300;
    var lastInputAt = new WeakMap();

    function cssPath (el) {
        if (!(el instanceof Element)) { return ''; }
        var parts = [];
        var node = el;
        for (var depth = 0; depth < 4 && node && node.nodeType === 1; depth++) {
            if (node.id) {
                parts.unshift('#' + node.id);
                break;
            }
            var tag = node.tagName.toLowerCase();
            var n = 1;
            for (var sib = node; (sib = sib.previousElementSibling);) {
                if (sib.tagName === node.tagName) { n++; }
            }
            parts.unshift(n > 1 ? tag + ':nth-of-type(' + n + ')' : tag);
            node = node.parentElement;
        }
        var path = parts.join(' > ');
        return path.length > 120 ? path.slice(0, 120) + '…' : path;
    }

    function snippet (el) {
        try {
            var t = (el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ');
            return t.slice(0, 80);
        } catch (e) { return ''; }
    }

    function valueOf (el) {
        try {
            if (el instanceof HTMLInputElement) {
                if (el.type === 'password') { return '••'; }
                if (el.type === 'checkbox' || el.type === 'radio') { return el.checked ? '✓' : '✗'; }
            }
            var v = el.value !== undefined ? el.value : el.innerText;
            if (typeof v !== 'string') { v = String(v); }
            return v.slice(0, 200);
        } catch (e) { return ''; }
    }

    function report (evt) {
        try {
            if (typeof window.__tabbyWvReport === 'function') {
                window.__tabbyWvReport(JSON.stringify(evt));
            }
        } catch (e) { /* binding gone (recorder detached) — dropped */ }
    }

    function base (kind, target) {
        return { kind: kind, t: Date.now(), frameUrl: location.href, selector: cssPath(target) };
    }

    document.addEventListener('click', function (ev) {
        var el = ev.target;
        if (!(el instanceof Element)) { return; }
        var e = base('click', el);
        e.snippet = snippet(el);
        e.x = Math.round(ev.clientX);
        e.y = Math.round(ev.clientY);
        report(e);
    }, true);

    function onInputLike (ev) {
        var el = ev.target;
        var editable = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            || el instanceof HTMLSelectElement) || (el instanceof Element && el.isContentEditable);
        if (!editable) { return; }
        if (ev.type === 'input') {
            // coalesce typing floods per target; the final value still lands
            // via the change event
            var now = Date.now();
            if (now - (lastInputAt.get(el) || 0) < COALESCE_MS) { return; }
            lastInputAt.set(el, now);
        }
        var e = base(ev.type === 'input' ? 'input' : 'change', el);
        e.value = valueOf(el);
        report(e);
    }
    document.addEventListener('input', onInputLike, true);
    document.addEventListener('change', onInputLike, true);

    document.addEventListener('submit', function (ev) {
        var el = ev.target;
        if (!(el instanceof HTMLFormElement)) { return; }
        var e = base('submit', el);
        e.snippet = (el.getAttribute('action') || '(this page)').slice(0, 80);
        report(e);
    }, true);
})();`
