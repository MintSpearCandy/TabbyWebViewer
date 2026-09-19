(() => {
    return JSON.stringify({
        modal: !!document.querySelector('.modal.show'),
        modalText: (document.querySelector('.modal.show') || {}).textContent ? document.querySelector('.modal.show').textContent.trim().slice(0, 120) : '',
        activeEl: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : 'none',
    })
})()
