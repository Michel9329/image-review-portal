// Image Review Portal front end. No build step, no dependencies. All text is set with
// textContent (never innerHTML), and nothing is loaded from other origins.
const app = document.getElementById('app');
const who = document.getElementById('who');
let me = null;

const STATUS = {
  empty: 'No image yet', changes_requested: 'Changes requested', needs_review: 'Fix to review',
  awaiting_approval: 'Awaiting approval', partially_approved: 'Partly approved', approved: 'Approved',
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// Node.replaceChildren() writes a null argument as the text "null": always go through this.
function show(...nodes) { app.replaceChildren(...nodes.flat().filter((n) => n != null && n !== false)); }

function csrf() { return (document.cookie.match(/(?:^|;\s*)irp_csrf=([^;]+)/) || [])[1] || ''; }

async function api(path, { method = 'GET', body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') init.headers['x-csrf-token'] = csrf();
  if (raw) init.body = raw;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'error'), { status: res.status, data });
  return data;
}

const MESSAGES = {
  not_signed_in: 'Please sign in.', forbidden: 'You are not allowed to do that.', not_found: 'Not found.',
  version_changed: 'A newer version arrived. Reload and look at it before approving.',
  too_large: 'That file is too large.', images_only: 'Only PNG, JPEG, WebP and GIF images are accepted.',
  same_file_already_uploaded: 'That exact file is already one of the versions.', wrong_code: 'Wrong code.',
  code_expired: 'The code expired. Ask for a new one.', too_many_attempts: 'Too many attempts. Ask for a new code.',
};
const say = (e) => MESSAGES[e.message] || e.message;

function go(path) { history.pushState({}, '', path); route(); }
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});
window.addEventListener('popstate', route);

function name(people, id) { return (people.find((p) => p.id === id) || {}).name || 'Someone'; }
const when = (t) => new Date(t * 1000).toLocaleString();

// --- views ------------------------------------------------------------------------------------

function loginView() {
  who.textContent = '';
  const err = h('p', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email', 'aria-label': 'Email', required: true });
  const code = h('input', { inputmode: 'numeric', placeholder: '6-digit code', autocomplete: 'one-time-code', 'aria-label': 'Code', maxlength: 7 });
  const step2 = h('div', { class: 'row' }, code, h('button', { onclick: verify }, 'Sign in'));
  step2.hidden = true;
  async function ask() {
    err.textContent = '';
    try { await api('/api/auth/code', { method: 'POST', body: { email: email.value } }); step2.hidden = false; code.focus(); err.textContent = 'If this address has access, a code is on its way.'; }
    catch (e) { err.textContent = say(e); }
  }
  async function verify() {
    err.textContent = '';
    try { await api('/api/auth/verify', { method: 'POST', body: { email: email.value, code: code.value } }); await start(); }
    catch (e) { err.textContent = say(e); }
  }
  show(h('h1', {}, 'Sign in'), h('div', { class: 'card' },
    h('p', { class: 'muted' }, 'Enter the email you were invited with. We send a 6-digit code.'),
    h('div', { class: 'row' }, email, h('button', { onclick: ask }, 'Send code')), err, step2));
}

async function projectsView() {
  const { projects } = await api('/api/projects');
  const err = h('p', { class: 'error', role: 'alert' });
  const nameIn = h('input', { placeholder: 'Project name', 'aria-label': 'Project name' });
  const nIn = h('input', { type: 'number', min: 1, max: 20, value: 1, 'aria-label': 'Signatures required', style: false });
  nIn.size = 3;
  const create = me.admin ? h('div', { class: 'card' }, h('h2', {}, 'New project'),
    h('div', { class: 'row' }, nameIn, h('label', {}, 'Signatures required ', nIn),
      h('button', { onclick: async () => { try { const r = await api('/api/projects', { method: 'POST', body: { name: nameIn.value, required_approvals: Number(nIn.value) } }); go('/project/' + r.id); } catch (e) { err.textContent = say(e); } } }, 'Create')), err) : null;
  show(h('h1', {}, 'Projects'),
    projects.length ? h('div', { class: 'grid' }, projects.map((p) => h('a', { class: 'tile', href: '/project/' + p.id, 'data-link': true },
      h('div', { class: 'meta' }, h('strong', {}, p.name), h('div', { class: 'muted' }, p.role ? p.role : 'admin', ' | ', p.required_approvals, p.required_approvals === 1 ? ' signature needed' : ' signatures needed')))))
      : h('p', { class: 'muted' }, me.admin ? 'No projects yet. Create the first one.' : 'You are not part of any project yet.'), create);
}

async function projectView(id) {
  const d = await api('/api/projects/' + id);
  const err = h('p', { class: 'error', role: 'alert' });
  const title = h('input', { placeholder: 'Image title', 'aria-label': 'Image title' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': 'Image file' });
  const canUpload = d.role === 'author' || d.admin;
  const upload = canUpload ? h('div', { class: 'card' }, h('h2', {}, d.images.length ? 'Add an image' : 'Upload the first image'), h('div', { class: 'row' }, title, file,
    h('button', { onclick: async () => {
      err.textContent = '';
      const f = file.files[0];
      if (!f || !title.value.trim()) { err.textContent = 'Add a title and choose a file.'; return; }
      try { const r = await api('/api/projects/' + id + '/images?title=' + encodeURIComponent(title.value), { method: 'POST', raw: f, headers: { 'x-filename': encodeURIComponent(f.name) } }); go('/image/' + r.image); }
      catch (e) { err.textContent = say(e); }
    } }, 'Upload')), err) : null;

  let admin = null;
  if (d.admin) {
    const em = h('input', { type: 'email', placeholder: 'person@example.com', 'aria-label': 'Member email' });
    const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'reviewer' }, 'reviewer'), h('option', { value: 'author' }, 'author'));
    const n = h('input', { type: 'number', min: 1, max: 20, value: d.project.required_approvals, 'aria-label': 'Signatures required' });
    const aerr = h('p', { class: 'error', role: 'alert' });
    admin = h('div', { class: 'card' }, h('h2', {}, 'Members'),
      d.members.map((m) => h('div', { class: 'row' }, h('span', {}, m.name, ' ', h('span', { class: 'muted' }, m.email || ''), ' (', m.role, ')'),
        h('button', { class: 'secondary', onclick: async () => { await api('/api/projects/' + id + '/members/' + m.id, { method: 'DELETE' }); route(); } }, 'Remove'))),
      h('div', { class: 'row' }, em, role, h('button', { onclick: async () => { try { await api('/api/projects/' + id + '/members', { method: 'POST', body: { email: em.value, role: role.value } }); route(); } catch (e) { aerr.textContent = say(e); } } }, 'Add')),
      h('div', { class: 'row' }, h('label', {}, 'Signatures required ', n),
        h('button', { class: 'secondary', onclick: async () => { try { await api('/api/projects/' + id, { method: 'PATCH', body: { required_approvals: Number(n.value) } }); route(); } catch (e) { aerr.textContent = say(e); } } }, 'Save')), aerr);
  }
  show(h('p', {}, h('a', { href: '/', 'data-link': true }, 'Projects')), h('h1', {}, d.project.name),
    h('p', { class: 'muted' }, d.project.required_approvals, d.project.required_approvals === 1 ? ' signature needed per image. Your role: ' : ' signatures needed per image. Your role: ', d.role || 'admin', '.'),
    d.images.length ? h('div', { class: 'grid' }, d.images.map((i) => h('a', { class: 'tile', href: '/image/' + i.id, 'data-link': true },
      i.current_version ? h('img', { src: '/api/versions/' + i.current_version + '/file', alt: i.title, loading: 'lazy' }) : null,
      h('div', { class: 'meta' }, h('strong', {}, i.title), h('div', {}, h('span', { class: 'chip ' + i.status }, STATUS[i.status]), ' ',
        h('span', { class: 'muted' }, i.approvals, '/', d.project.required_approvals, ' signed')))))) : h('p', { class: 'muted' }, canUpload ? 'No images yet. Upload the first one below.' : 'No images yet. The author will upload them here.'),
    upload, admin);
}

async function imageView(id, versionId, activeComment) {
  const d = await api('/api/images/' + id);
  const shown = versionId || d.image.current_version;
  const version = d.versions.find((v) => v.id === shown) || d.versions[d.versions.length - 1];
  const isCurrent = version && version.id === d.image.current_version;
  const canPin = (d.role === 'reviewer' || (d.admin && !d.role)) && isCurrent;
  const err = h('p', { class: 'error', role: 'alert' });
  const refresh = (vid, cid) => imageView(id, vid, cid);
  const fail = (e) => { err.textContent = say(e); };

  const stage = h('div', { class: 'stage' + (canPin ? ' pinning' : '') });
  const draft = { x: null, y: null };
  const draftPin = h('span', { class: 'pin draft' }, '+');
  draftPin.hidden = true;
  const bodyIn = h('textarea', { placeholder: canPin ? 'Click the image to drop a pin, then write. No pin makes it a general comment.' : 'Comments are added on the current version by reviewers.', 'aria-label': 'New comment', disabled: !canPin });
  if (version) {
    const img = h('img', { src: '/api/versions/' + version.id + '/file', alt: d.image.title });
    stage.append(img, draftPin);
    for (const c of d.comments.filter((c) => c.version_id === version.id && c.x != null)) {
      const pin = h('button', { class: 'pin ' + c.status, title: 'Comment ' + c.number, 'aria-label': 'Comment ' + c.number, onclick: (e) => { e.stopPropagation(); refresh(version.id, c.id); } }, c.number);
      pin.style.left = c.x * 100 + '%'; pin.style.top = c.y * 100 + '%';
      stage.append(pin);
    }
    if (canPin) stage.addEventListener('click', (e) => {
      const r = img.getBoundingClientRect();
      draft.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); draft.y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      draftPin.style.left = draft.x * 100 + '%'; draftPin.style.top = draft.y * 100 + '%'; draftPin.hidden = false; bodyIn.focus();
    });
  }

  const versionSel = h('select', { 'aria-label': 'Version', onchange: (e) => refresh(e.target.value) },
    d.versions.map((v) => h('option', { value: v.id, selected: v.id === (version && version.id) }, 'Version ' + v.number + (v.id === d.image.current_version ? ' (current)' : ''))));

  const signed = d.signed_by.map((uid) => name(d.people, uid));
  const reviewerIds = d.people.filter((p) => p.role === 'reviewer').map((p) => p.id);
  const iSigned = d.signed_by.includes(me.id);
  const approvePanel = h('div', { class: 'card' },
    h('div', {}, h('span', { class: 'chip ' + d.status }, STATUS[d.status]), ' ', h('strong', {}, d.approvals + ' of ' + d.required), ' signatures'),
    h('div', { class: 'signers muted' }, [
      signed.length ? 'Signed by ' + signed.join(', ') + '.' : 'No signatures on this version yet.',
      d.missing ? ' ' + d.missing + ' more needed' + (reviewerIds.length < d.required ? ' (only ' + reviewerIds.length + ' reviewer(s) in the project)' : '') + '.' : '']),
    d.role === 'reviewer' && isCurrent ? h('div', { class: 'row' },
      !iSigned ? h('button', { onclick: async () => { try { await api('/api/images/' + id + '/approve', { method: 'POST', body: { version: d.image.current_version } }); refresh(); } catch (e) { fail(e); if (e.message === 'version_changed') refresh(); } } }, 'Approve this version')
        : h('button', { class: 'secondary', onclick: async () => { try { await api('/api/images/' + id + '/unapprove', { method: 'POST' }); refresh(); } catch (e) { fail(e); } } }, 'Withdraw my approval')) : null);

  const threads = d.comments.map((c) => {
    const msgs = d.messages.filter((m) => m.comment_id === c.id);
    const replyIn = h('textarea', { 'aria-label': 'Reply to comment ' + c.number, placeholder: 'Reply' });
    const canReply = d.role || d.admin;
    return h('div', { class: 'thread' + (c.id === activeComment ? ' active' : ''), id: 'c-' + c.id },
      h('div', {}, h('strong', {}, '#' + c.number), ' ', h('span', { class: 'chip' }, c.status), ' ', h('span', { class: 'muted' }, 'on version ' + (d.versions.find((v) => v.id === c.version_id) || {}).number)),
      msgs.map((m) => h('div', { class: 'msg' }, h('b', {}, name(d.people, m.author)), ' ', h('span', { class: 'muted' }, when(m.created)), h('br'), m.body)),
      canReply ? h('div', {}, replyIn, h('div', { class: 'row' },
        h('button', { class: 'secondary', onclick: async () => { if (!replyIn.value.trim()) return; try { await api('/api/comments/' + c.id + '/messages', { method: 'POST', body: { body: replyIn.value } }); refresh(version && version.id, c.id); } catch (e) { fail(e); } } }, 'Reply'),
        d.role === 'author' && c.status === 'open' ? h('button', { class: 'secondary', onclick: async () => { try { await api('/api/comments/' + c.id + '/status', { method: 'POST', body: { status: 'addressed' } }); refresh(version && version.id); } catch (e) { fail(e); } } }, 'Mark as addressed') : null,
        d.role === 'reviewer' && c.status !== 'resolved' ? h('button', { class: 'secondary', onclick: async () => { try { await api('/api/comments/' + c.id + '/status', { method: 'POST', body: { status: 'resolved' } }); refresh(version && version.id); } catch (e) { fail(e); } } }, 'Resolve') : null,
        d.role === 'reviewer' && c.status === 'resolved' ? h('button', { class: 'secondary', onclick: async () => { try { await api('/api/comments/' + c.id + '/status', { method: 'POST', body: { status: 'open' } }); refresh(version && version.id); } catch (e) { fail(e); } } }, 'Reopen') : null)) : null);
  });

  const newComment = canPin ? h('div', { class: 'card' }, bodyIn, h('div', { class: 'row' },
    h('button', { onclick: async () => {
      if (!bodyIn.value.trim()) return;
      try { await api('/api/images/' + id + '/comments', { method: 'POST', body: { version: version.id, x: draft.x, y: draft.y, body: bodyIn.value } }); refresh(version.id); }
      catch (e) { fail(e); } } }, 'Add comment'))) : null;

  let newVersion = null;
  if (d.role === 'author' || d.admin) {
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': 'New version file' });
    const note = h('input', { placeholder: 'What changed?', 'aria-label': 'What changed' });
    const open = d.comments.filter((c) => c.status === 'open').map((c) => c.id);
    newVersion = h('div', { class: 'card' }, h('h2', {}, 'Upload a new version'), h('p', { class: 'muted' }, 'Signatures are reset. Open comments are marked as addressed (' + open.length + ').'),
      h('div', { class: 'row' }, file, note, h('button', { onclick: async () => {
        const f = file.files[0]; if (!f) { err.textContent = 'Choose a file.'; return; }
        try { await api('/api/images/' + id + '/versions?note=' + encodeURIComponent(note.value) + '&resolves=' + open.join(','), { method: 'POST', raw: f, headers: { 'x-filename': encodeURIComponent(f.name) } }); refresh(); }
        catch (e) { fail(e); } } }, 'Upload')));
  }

  show(h('p', {}, h('a', { href: '/project/' + d.image.project_id, 'data-link': true }, d.project.name)), h('h1', {}, d.image.title),
    h('div', { class: 'layout' },
      h('div', {}, h('div', { class: 'row' }, versionSel, version ? h('a', { class: 'btn secondary', href: '/api/versions/' + version.id + '/file?download=1' }, 'Download') : null,
        version && version.note ? h('span', { class: 'muted' }, 'Note: ' + version.note) : null), h('div', { class: 'stage-wrap' }, stage), err, newVersion),
      h('div', {}, approvePanel, h('h2', {}, 'Comments (' + d.comments.length + ')'), newComment, threads.length ? threads : h('p', { class: 'muted' }, 'No comments yet.'))));
  if (activeComment) document.getElementById('c-' + activeComment)?.scrollIntoView({ block: 'nearest' });
}

// --- boot -------------------------------------------------------------------------------------

async function route() {
  if (!me) return loginView();
  const path = location.pathname;
  try {
    let m;
    if ((m = path.match(/^\/project\/([\w-]+)$/))) await projectView(m[1]);
    else if ((m = path.match(/^\/image\/([\w-]+)$/))) await imageView(m[1]);
    else await projectsView();
  } catch (e) {
    if (e.status === 401) { me = null; loginView(); return; }
    show(h('p', { class: 'error', role: 'alert' }, say(e)), h('a', { href: '/', 'data-link': true }, 'Back to projects'));
  }
}

async function start() {
  try { me = await api('/api/me'); } catch { me = null; }
  who.replaceChildren();
  if (me) who.append(me.name + ' ', h('button', { class: 'secondary', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); me = null; route(); } }, 'Sign out'));
  route();
}
start();
