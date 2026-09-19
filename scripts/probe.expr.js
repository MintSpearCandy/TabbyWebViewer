(() => {
    const modal = document.querySelector('.modal.show') || document.body
    const els = [...modal.querySelectorAll('*')].filter(x => x.children.length === 0 && (x.textContent || '').trim().length > 1)
    return JSON.stringify({
        count: els.length,
        sample: [...new Set(els.map(x => (x.textContent || '').trim().slice(0, 45)))].slice(0, 15),
        hasInput: !!modal.querySelector('input'),
    })
})()
