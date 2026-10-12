(function (global) {
  'use strict';

  var state = { host: null, submit: null, form: null, status: null, list: null, busy: false };
  var config = global.GUESTBOOK_CONFIG || {};

  function esc(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function textLength(value) { return Array.from(String(value || '')).length; }
  function configured() { return !!(config.enabled && config.projectUrl && config.anonKey); }
  function api(path) { return String(config.projectUrl).replace(/\/$/, '') + '/rest/v1/' + config.table + path; }
  function headers() { return { apikey: config.anonKey, Authorization: 'Bearer ' + config.anonKey, 'Content-Type': 'application/json' }; }
  function setStatus(message, kind) {
    if (!state.status) return;
    state.status.textContent = message || '';
    state.status.setAttribute('data-kind', kind || '');
  }
  function formatDate(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.getFullYear() + '.' + String(date.getMonth() + 1).padStart(2, '0') + '.' + String(date.getDate()).padStart(2, '0');
  }
  function listHTML(rows) {
    if (!rows.length) return '<p class="c-echo__empty">这里还没有回声。你可以留下第一句。</p>';
    return rows.map(function (row) {
      var name = row.nickname ? esc(row.nickname) : '一位经过这里的人';
      return '<article class="c-echo__entry"><div class="c-echo__entry-meta"><span>' + name + '</span><time>' +
        esc(formatDate(row.created_at)) + '</time></div><p>' + esc(row.message) + '</p></article>';
    }).join('');
  }
  function render(host) {
    host.innerHTML = '<section class="c-echo" aria-labelledby="echo-form-title">' +
      '<div class="c-echo__wave" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '<p class="c-echo__lead">留下你经过这里时，想说的一句话。</p>' +
      '<form class="c-echo__form" novalidate>' +
      '<label><span>怎么称呼你</span><input name="nickname" maxlength="40" autocomplete="nickname" placeholder="可不填"></label>' +
      '<label><span id="echo-form-title">想留下什么</span><textarea name="message" rows="4" maxlength="' + (Number(config.maxLength) || 300) + '" required placeholder="写点什么吧"></textarea></label>' +
      '<label class="c-echo__trap" aria-hidden="true">网站<input name="website" tabindex="-1" autocomplete="off"></label>' +
      '<div class="c-echo__actions"><span class="c-echo__status" role="status" aria-live="polite"></span><button type="submit" class="c-echo__submit">留下回声</button></div>' +
      '</form><div class="c-echo__list" aria-live="polite"></div></section>';
    state.host = host; state.form = host.querySelector('form'); state.status = host.querySelector('.c-echo__status');
    state.list = host.querySelector('.c-echo__list'); state.submit = host.querySelector('button[type="submit"]');
    state.form.addEventListener('submit', submit);
    if (!configured()) {
      state.submit.disabled = true;
      setStatus('留言服务正在准备中。', 'info');
      state.list.innerHTML = '<p class="c-echo__empty">回声很快会在这里汇聚。</p>';
      return;
    }
    load();
  }
  function load() {
    state.list.innerHTML = '<p class="c-echo__loading">正在听取回声……</p>';
    fetch(api('?select=id,nickname,message,created_at&status=eq.approved&order=created_at.desc&limit=' + (Number(config.pageSize) || 60)), { headers: headers() })
      .then(function (response) { if (!response.ok) throw new Error('read ' + response.status); return response.json(); })
      .then(function (rows) { if (state.list) state.list.innerHTML = listHTML(Array.isArray(rows) ? rows : []); })
      .catch(function () { if (state.list) state.list.innerHTML = '<p class="c-echo__empty">回声暂时没有传到这里，请稍后再来。</p>'; });
  }
  function submit(event) {
    event.preventDefault(); if (state.busy || !configured()) return;
    var form = state.form, nickname = form.nickname.value.trim(), message = form.message.value.trim();
    if (form.website.value) return;
    if (!message) { setStatus('请先写下一句话。', 'error'); form.message.focus(); return; }
    if (textLength(message) > (Number(config.maxLength) || 300)) { setStatus('留言请控制在 ' + (Number(config.maxLength) || 300) + ' 字以内。', 'error'); return; }
    state.busy = true; state.submit.disabled = true; setStatus('正在把这句话送出去……', 'info');
    fetch(api(''), { method: 'POST', headers: Object.assign({}, headers(), { Prefer: 'return=minimal' }),
      body: JSON.stringify({ nickname: nickname || null, message: message, status: 'pending' }) })
      .then(function (response) { if (!response.ok) throw new Error('write ' + response.status); form.reset(); setStatus('已经收到。审核后，它会出现在这里。', 'success'); })
      .catch(function () { setStatus('这句话暂时没有送达，请稍后再试。', 'error'); })
      .then(function () { state.busy = false; state.submit.disabled = false; });
  }
  function mount(host) { if (host) render(host); }
  function unmount() { state.host = null; state.form = null; state.status = null; state.list = null; state.submit = null; state.busy = false; }
  global.Guestbook = { mount: mount, unmount: unmount, configured: configured };
})(typeof window !== 'undefined' ? window : this);
