// Minimal sidebar script: reads saved items from chrome.storage and renders a simple list.
// This is a tiny placeholder so the compiled `sidebar.js` exists for the HTML to load.
function renderGroups(groups, itemsMap) {
    const container = document.getElementById('context-tree-list');
    if (!container)
        return;
    container.innerHTML = '';
    const groupKeys = Object.keys(groups || {});
    if (!groupKeys.length) {
        container.innerHTML = '<p>No hay elementos guardados todavía.</p>';
        return;
    }
    for (const key of groupKeys) {
        const group = groups[key];
        const section = document.createElement('section');
        section.className = 'group';
        const header = document.createElement('button');
        header.className = 'group-header';
        header.textContent = `${group.title} (${group.items.length})`;
        header.setAttribute('aria-expanded', 'false');
        const list = document.createElement('ul');
        list.style.display = 'none';
        header.addEventListener('click', () => {
            const expanded = header.getAttribute('aria-expanded') === 'true';
            header.setAttribute('aria-expanded', expanded ? 'false' : 'true');
            list.style.display = expanded ? 'none' : 'block';
        });
        for (const sid of group.items) {
            const item = itemsMap[sid];
            const li = document.createElement('li');
            const title = item?.title || item?.source_id || (item?.original_text || '').slice?.(0, 80) || sid;
            const span = document.createElement('span');
            span.textContent = title;
            span.style.marginRight = '8px';
            const goto = document.createElement('button');
            goto.textContent = 'Ir al mensaje';
            goto.style.marginLeft = '8px';
            goto.addEventListener('click', () => {
                try {
                    chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_SOURCE', payload: { pageUrl: item.pageUrl || window.location.href, sourceId: sid } });
                }
                catch (e) {
                    console.error('Failed to request navigation', e);
                }
            });
            li.appendChild(span);
            li.appendChild(goto);
            list.appendChild(li);
        }
        section.appendChild(header);
        section.appendChild(list);
        container.appendChild(section);
    }
}
function loadGroups() {
    const storage = (chrome && chrome.storage && chrome.storage.local) ? chrome.storage.local : null;
    if (!storage) {
        renderGroups({}, {});
        return;
    }
    storage.get(['groupsIndex'], (data) => {
        const groups = data?.groupsIndex || {};
        // build items map for quick access
        const allKeys = Object.values(groups).flatMap((g) => g.items || []);
        if (!allKeys.length) {
            renderGroups(groups, {});
            return;
        }
        storage.get(allKeys, (itemsData) => {
            renderGroups(groups, itemsData || {});
        });
    });
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        loadGroups();
        // listen for storage changes to update live
        chrome.storage.onChanged.addListener(() => loadGroups());
    }, { once: true });
}
else {
    loadGroups();
    chrome.storage.onChanged.addListener(() => loadGroups());
}
