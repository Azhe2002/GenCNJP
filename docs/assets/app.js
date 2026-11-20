/* 字形保真标注 · 在线标注前端
 *
 * 纯静态：作答进度存 localStorage；配置 Supabase 后自动增量同步；
 * 未配置时也能完整作答，并在结束页导出 JSON。
 * key_nat.json（A0/A3 的左右映射）不在此页面中，分析时在本地合并。
 */
(function () {
  'use strict';

  var CFG = Object.assign({
    version: '1.0.0',
    studyName: 'MIXIDIOM-69 字形保真人工标注',
    contactEmail: '',
    contactUrl: 'https://github.com/Azhe2002',
    supabaseUrl: '',
    supabaseAnonKey: '',
    syncEveryN: 15
  }, window.SURVEY_CONFIG || {});

  var SCHEMA = 1;
  var STORE = 'gencnjp_survey_v1';
  var TASKS = ['id', 'dak', 'nat'];
  var TASK_NAME = { id: '身份标注', dak: '浊点完整性', nat: '自然度盲评' };
  var TASK_DESC = {
    id: '看整行图里红框标出的格子，判断它写成了假名、原来的熟字、都不像，还是空白。约 10 分钟。',
    dak: '只看带浊点／半浊点的假名：右上角的两点或小圈是否完整。约 4 分钟。',
    nat: '两张同位置的图，分别打 1–5 分自然度。约 20 分钟。'
  };
  var TASK_MINUTES = { id: '约 10 分钟', dak: '约 4 分钟', nat: '约 20 分钟' };

  var ID_CHOICES = [
    { key: 1, v: 'cond', label: '条件（假名）', sub: '写的是假名' },
    { key: 2, v: 'prior', label: '先验（原熟字）', sub: '写成了原来的汉字' },
    { key: 3, v: 'neither', label: '都不像', sub: '糊、碎、认不出' },
    { key: 4, v: 'blank', label: '空白', sub: '格里没有墨迹' }
  ];

  var DAK_CHOICES = [
    { key: 1, v: 'complete', label: '点完整', sub: '位置也对（右上角）' },
    { key: 2, v: 'missing', label: '点缺失', sub: '写成了清音（如 ざ→さ）' },
    { key: 3, v: 'misplaced', label: '错位／糊住', sub: '偏位、粘连、糊成一团' },
    { key: 4, v: 'unclear', label: '看不出', sub: '太小或太糊，无法判断' }
  ];

  var RATE_LABEL = { 1: '一眼假', 2: '明显贴的', 3: '能接受', 4: '基本自然', 5: '完全自然' };

  var app = document.getElementById('app');
  var topStatusEl = document.getElementById('topStatus');
  var toastEl = document.getElementById('toast');
  var zoomEl = document.getElementById('zoom');
  var zoomImg = document.getElementById('zoomImg');

  var DATA = null;
  var ITEMS = [];
  var DAK_ITEMS = [];
  var S = null;
  var view = { screen: 'boot', task: null };
  var sync = { sending: false, lastOk: 0, error: '', retryTimer: null };
  var toastTimer = null;

  /* ------------------------------------------------------------------ 工具 */

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function nowISO() { return new Date().toISOString(); }

  function uid() {
    try {
      if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      if (window.crypto && crypto.getRandomValues) {
        var b = new Uint8Array(16);
        crypto.getRandomValues(b);
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        var h = Array.prototype.map.call(b, function (x) {
          return ('0' + x.toString(16)).slice(-2);
        }).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) +
          '-' + h.slice(16, 20) + '-' + h.slice(20);
      }
    } catch (e) { /* fall through */ }
    var s = 'xxxxxxxxyxxxxyxxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
    return s;
  }

  function makeCode() {
    var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    var out = '';
    try {
      var b = new Uint8Array(6);
      crypto.getRandomValues(b);
      for (var i = 0; i < 6; i++) out += alphabet[b[i] % alphabet.length];
    } catch (e) {
      for (var j = 0; j < 6; j++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2300);
  }

  function copyText(text, okMsg) {
    var done = function () { toast(okMsg || '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选择'); }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------------------ 状态 */

  function newSession() {
    return {
      schema: SCHEMA,
      sessionId: uid(),
      code: makeCode(),
      consent: false,
      startedAt: nowISO(),
      demographics: null,
      answers: { id: [], dak: [], nat: [] },
      natPending: null,
      lastSnapshot: { id: 0, dak: 0, nat: 0 },
      lastTask: null,
      queue: [],
      participantQueued: false,
      finishedAt: null
    };
  }

  function save() {
    if (!S) return;
    try {
      localStorage.setItem(STORE, JSON.stringify(S));
    } catch (e) {
      toast('本机存储空间不足，请下载结果后重新开始');
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.schema !== SCHEMA || !s.sessionId) return null;
      s.answers = s.answers || { id: [], dak: [], nat: [] };
      TASKS.forEach(function (t) { if (!Array.isArray(s.answers[t])) s.answers[t] = []; });
      s.queue = Array.isArray(s.queue) ? s.queue : [];
      s.lastSnapshot = s.lastSnapshot || { id: 0, dak: 0, nat: 0 };
      return s;
    } catch (e) {
      return null;
    }
  }

  function taskItems(t) { return t === 'dak' ? DAK_ITEMS : ITEMS; }
  function totalOf(t) { return taskItems(t).length; }
  function answeredCount(t) { return S ? S.answers[t].length : 0; }
  function totalAll() { return ITEMS.length * 2 + DAK_ITEMS.length; }
  function answeredAll() {
    return TASKS.reduce(function (n, t) { return n + answeredCount(t); }, 0);
  }
  function allDone() {
    return TASKS.every(function (t) { return answeredCount(t) >= totalOf(t); });
  }
  function currentItem() {
    var seq = taskItems(view.task);
    return seq[S.answers[view.task].length] || null;
  }

  function imgGen(idx) { return './assets/img/id/' + pad2(idx) + '_gen.webp'; }
  function imgCond(idx) { return './assets/img/id/' + pad2(idx) + '_cond.webp'; }
  function imgPrior(idx) { return './assets/img/id/' + pad2(idx) + '_prior.webp'; }
  function imgNat(idx, side) { return './assets/img/nat/' + pad2(idx) + '_' + side + '.webp'; }

  /* ------------------------------------------------------------------ 上传 */

  function backendReady() {
    return /^https:\/\//i.test(String(CFG.supabaseUrl || '').trim()) &&
      String(CFG.supabaseAnonKey || '').trim().length > 20;
  }

  function participantBody() {
    return {
      session_id: S.sessionId,
      code: S.code,
      consent: true,
      demographics: S.demographics,
      user_agent: String(navigator.userAgent || '').slice(0, 500),
      client_started_at: S.startedAt
    };
  }

  function responseBody(task, completed) {
    return {
      submission_id: uid(),
      session_id: S.sessionId,
      task: task,
      completed: !!completed,
      n_answered: S.answers[task].length,
      client_saved_at: nowISO(),
      payload: {
        schema: SCHEMA,
        study: 'MIXIDIOM-69',
        version: CFG.version,
        code: S.code,
        task: task,
        started_at: S.startedAt,
        answers: S.answers[task]
      }
    };
  }

  function enqueue(table, body) {
    if (!S) return;
    if (table === 'participants') {
      if (S.participantQueued) return;
      S.participantQueued = true;
    }
    S.queue.push({ table: table, body: body });
    if (S.queue.length > 80) S.queue = S.queue.slice(-80);
    save();
    updateStatus();
    flush();
  }

  function submitTask(task, completed) {
    if (!S) return;
    S.lastSnapshot[task] = S.answers[task].length;
    enqueue('responses', responseBody(task, completed));
  }

  function postRow(row, keepalive) {
    var base = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
    var conflict = row.table === 'participants' ? 'session_id' : 'submission_id';
    var url = base + '/rest/v1/' + row.table + '?on_conflict=' + conflict;
    var controller = null;
    var timer = null;
    if (!keepalive && typeof AbortController === 'function') {
      controller = new AbortController();
      timer = setTimeout(function () { controller.abort(); }, 15000);
    }
    var headers = {
      'Content-Type': 'application/json',
      'apikey': CFG.supabaseAnonKey,
      'Prefer': 'resolution=ignore-duplicates,return=minimal'
    };
    // Legacy anon/service keys are JWTs and also go in Authorization.
    // New sb_publishable_... keys are NOT JWTs and must stay in apikey only.
    if (/^eyJ/.test(CFG.supabaseAnonKey)) {
      headers['Authorization'] = 'Bearer ' + CFG.supabaseAnonKey;
    }
    return fetch(url, {
      method: 'POST',
      mode: 'cors',
      keepalive: !!keepalive,
      headers: headers,
      body: JSON.stringify(row.body),
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (res.ok || res.status === 409) return true;
      return res.text().then(function (text) {
        throw new Error('HTTP ' + res.status + (text ? ' ' + text.slice(0, 140) : ''));
      }, function () {
        throw new Error('HTTP ' + res.status);
      });
    }).then(function (ok) {
      if (timer) clearTimeout(timer);
      return ok;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function flush() {
    if (!S || !backendReady() || sync.sending) { updateStatus(); return; }
    if (!navigator.onLine || !S.queue.length) { updateStatus(); return; }
    sync.sending = true;
    updateStatus();
    var step = function () {
      if (!S.queue.length) {
        finish();
        return;
      }
      var row = S.queue[0];
      postRow(row, false).then(function () {
        S.queue.shift();
        sync.lastOk = Date.now();
        sync.error = '';
        save();
        updateStatus();
        step();
      }, function (err) {
        sync.error = err && err.message ? err.message : String(err);
        finish();
        clearTimeout(sync.retryTimer);
        sync.retryTimer = setTimeout(flush, 20000);
      });
    };
    var finish = function () {
      sync.sending = false;
      updateStatus();
    };
    step();
  }

  function syncText() {
    if (!backendReady()) return { t: '仅本机保存', cls: 'local' };
    if (sync.sending) return { t: '正在同步…', cls: 'busy' };
    if (S && S.queue.length) return { t: '待上传 ' + S.queue.length, cls: 'wait' };
    if (sync.lastOk) return { t: '已同步', cls: 'ok' };
    return { t: '已保存', cls: 'ok' };
  }

  function updateStatus() {
    if (topStatusEl) {
      if (!S) {
        topStatusEl.innerHTML = '<span class="pill local">匿名 · 无需登录</span>';
      } else {
        var st = syncText();
        topStatusEl.innerHTML =
          '<button class="codechip" id="copyCodeTop" title="点击复制完成码">' + esc(S.code) + '</button>' +
          '<span class="pill ' + st.cls + '">' + esc(st.t) + '</span>';
      }
    }
    var box = document.getElementById('syncBox');
    if (box && S) box.innerHTML = syncBoxHTML();
  }

  /* ------------------------------------------------------------------ 渲染 */

  function go(screen, opts) {
    view.screen = screen;
    if (opts && opts.task) view.task = opts.task;
    render();
  }

  function render() {
    var s = view.screen;
    var html = '';
    if (s === 'welcome') html = viewWelcome();
    else if (s === 'demo') html = viewDemo();
    else if (s === 'resume') html = viewResume();
    else if (s === 'hub') html = viewHub();
    else if (s === 'task') html = viewTask();
    else if (s === 'taskdone') html = viewTaskDone();
    else if (s === 'done') html = viewDone();
    else html = viewBoot('正在加载…');
    app.innerHTML = html;
    updateStatus();
    window.scrollTo(0, 0);
  }

  function viewBoot(msg) {
    return '<section class="narrow center"><p class="eyebrow">MIXIDIOM-69</p>' +
      '<h1>字形保真标注</h1><p class="lead">' + esc(msg) + '</p>' +
      '<div class="spinner" aria-hidden="true"></div></section>';
  }

  function viewBootError(err) {
    return '<section class="narrow center"><p class="eyebrow">加载失败</p>' +
      '<h1>页面素材没有加载出来</h1>' +
      '<p class="lead">请检查网络后刷新。如果是本地打开文件，请通过网页服务器访问。</p>' +
      '<p class="fine mono">' + esc(err && err.message ? err.message : err) + '</p>' +
      '<button class="btn primary" onclick="location.reload()">刷新页面</button></section>';
  }

  function viewWelcome() {
    return '<section class="hero">' +
      '<p class="eyebrow">MIXIDIOM-69 · 人工标注</p>' +
      '<h1>中日混排字形保真<br><span class="thin">在线标注</span></h1>' +
      '<p class="lead">你会看到 AI 生成的四字熟语图片，需要判断红框标出的那一格“像哪个字”、' +
      '浊点是否完整，以及两张图写下来的自然度。凭第一感觉作答即可，没有标准答案。</p>' +
      '<div class="facts">' +
        '<div><b>40–50 分钟</b><span>可分多次完成，进度自动保存</span></div>' +
        '<div><b>3 个任务</b><span>身份 · 浊点 · 自然度</span></div>' +
        '<div><b>匿名</b><span>无需登录，不要求姓名</span></div>' +
      '</div>' +
      '<div class="card consent-card">' +
        '<h2>参与须知</h2>' +
        '<ul class="bullets">' +
          '<li>这是学术研究的人工标注页面，判断结果只用于模型评估和论文的汇总分析。</li>' +
          '<li>系统随机分配一个 <strong>完成码</strong>，不要求填写姓名或账号。' +
            '托管与数据库服务可能保留常规访问日志。</li>' +
          '<li>作答进度保存在你的浏览器里，可以随时关闭，下次打开继续。</li>' +
          '<li>如中途退出并希望删除数据，请保留完成码并联系研究者。</li>' +
        '</ul>' +
        '<label class="consent"><input type="checkbox" id="consentBox">' +
          '<span>我已年满 18 周岁，已阅读上述说明，自愿参与本研究。</span></label>' +
        '<button class="btn primary big" id="startBtn" disabled>开始</button>' +
        '<p class="fine">建议使用电脑或平板；手机上也能完成，图片可以点开放大。</p>' +
      '</div></section>';
  }

  function viewDemo() {
    var d = (S && S.demographics) || {};
    function sel(name, label, opts) {
      return '<label class="field"><span>' + label + '</span><select name="' + name + '" required>' +
        '<option value="">请选择</option>' +
        opts.map(function (o) {
          var v = Array.isArray(o) ? o[0] : o;
          var t = Array.isArray(o) ? o[1] : o;
          return '<option value="' + esc(v) + '"' + (d[name] === v ? ' selected' : '') + '>' + esc(t) + '</option>';
        }).join('') + '</select></label>';
    }
    return '<section class="narrow">' +
      '<p class="eyebrow">开始之前</p>' +
      '<h1>参与者信息</h1>' +
      '<p class="lead small">只用于分组统计，不会用于识别个人。带 * 的为必填。</p>' +
      '<form id="demoForm" class="card form" novalidate>' +
        sel('native_lang', '母语 *', [['zh', '中文'], ['ja', '日语'], ['other', '其他']]) +
        sel('kana', '对日语假名的熟悉程度 *', [
          ['none', '完全不认识'], ['seen', '见过，但读不出'],
          ['read', '能读假名'], ['fluent', '熟练（N2 及以上）']
        ]) +
        sel('age', '年龄段（选填）', [
          ['18-24', '18–24'], ['25-34', '25–34'], ['35-44', '35–44'],
          ['45+', '45 及以上'], ['na', '不愿透露']
        ]).replace(' required', '') +
        sel('prior', '是否参加过本研究 *', [['no', '没有'], ['yes', '参加过']]) +
        '<label class="field"><span>联系方式（选填）</span>' +
          '<input name="contact" type="text" maxlength="120" autocomplete="off" ' +
          'placeholder="邮箱 / 微信，仅用于追问或致谢" value="' + esc(d.contact || '') + '"></label>' +
        '<div class="formfoot">' +
          '<button class="btn ghost" type="button" id="backWelcome">← 返回</button>' +
          '<button class="btn primary" type="submit">开始任务</button>' +
        '</div>' +
        '<p class="fine">提交后会生成 6 位完成码，请记下。它也是之后查询或删除数据的唯一凭据。</p>' +
      '</form></section>';
  }

  function viewResume() {
    var total = totalAll();
    var done = answeredAll();
    var pct = total ? Math.round(done * 100 / total) : 0;
    return '<section class="narrow center">' +
      '<p class="eyebrow">检测到未完成的进度</p>' +
      '<h1>继续上次的标注？</h1>' +
      '<p class="lead">完成码 <strong class="mono">' + esc(S.code) + '</strong><br>' +
        '已完成 ' + done + ' / ' + total + ' 条判断</p>' +
      '<div class="progressbar big"><i style="width:' + pct + '%"></i></div>' +
      '<div class="rowbtns">' +
        '<button class="btn primary" id="resumeBtn">继续</button>' +
        '<button class="btn ghost danger" id="restartBtn">重新开始</button>' +
      '</div>' +
      '<p class="fine">“重新开始”会清除本机上的当前进度，并且不会上传。</p>' +
      '</section>';
  }

  function viewHub() {
    var total = totalAll();
    var done = answeredAll();
    var pct = total ? Math.round(done * 100 / total) : 0;
    return '<section>' +
      '<div class="hubhead"><div>' +
        '<p class="eyebrow">完成码 ' + esc(S.code) + '</p>' +
        '<h1>任务列表</h1>' +
        '<p class="muted">三个任务可以按任意顺序完成，也可以中途退出。每答一题都会自动保存。</p>' +
      '</div><div class="overall"><span class="bigpct">' + pct + '%</span>' +
        '<span class="muted">' + done + ' / ' + total + '</span></div></div>' +
      '<div class="progressbar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="taskgrid">' + TASKS.map(taskCardHTML).join('') + '</div>' +
      '<div class="card syncbox" id="syncBox">' + syncBoxHTML() + '</div>' +
      '<div class="hubfoot">' +
        '<button class="btn ghost danger" id="restart2">重新开始</button>' +
        '<button class="btn primary" id="finishBtn"' + (allDone() ? '' : ' disabled') + '>' +
          (allDone() ? '查看并提交结果' : '完成全部任务后提交') + '</button>' +
      '</div></section>';
  }

  function taskCardHTML(t) {
    var total = totalOf(t);
    var n = answeredCount(t);
    var done = n >= total;
    var pct = total ? Math.round(n * 100 / total) : 0;
    var status = done ? '已完成' : (n ? '进行中' : '未开始');
    var cls = done ? 'ok' : (n ? 'doing' : 'todo');
    var num = String(TASKS.indexOf(t) + 1);
    return '<article class="card taskcard ' + (done ? 'is-done' : '') + '">' +
      '<div class="taskcard-top"><span class="tasknum">任务 ' + num + '</span>' +
        '<span class="status ' + cls + '">' + status + '</span></div>' +
      '<h2>' + TASK_NAME[t] + '</h2>' +
      '<p class="muted small">' + TASK_DESC[t] + '</p>' +
      '<div class="progressbar small"><i style="width:' + pct + '%"></i></div>' +
      '<div class="taskcard-foot"><span class="muted small">' + n + ' / ' + total +
        ' · ' + TASK_MINUTES[t] + '</span>' +
        '<button class="btn ' + (done ? 'ghost' : 'primary') + ' small" data-task="' + t + '">' +
          (done ? '查看完成页' : (n ? '继续' : '开始')) + '</button></div></article>';
  }

  function syncBoxHTML() {
    if (!backendReady()) {
      return '<div class="syncline"><span class="dot local"></span>' +
        '<span>云端收集尚未启用。作答会保存在本机，结束页可以下载结果文件。</span></div>';
    }
    if (S.queue.length) {
      return '<div class="syncline"><span class="dot wait"></span>' +
        '<span>有 ' + S.queue.length + ' 条记录待上传。' +
        '<button class="linkbtn" id="retryBtn">立即重试</button></span></div>';
    }
    return '<div class="syncline"><span class="dot ok"></span>' +
      '<span>作答已自动同步到云端。</span>' +
      '<button class="linkbtn" id="downloadBtn">下载备份</button></div>';
  }

  function viewTask() {
    var t = view.task;
    var seq = taskItems(t);
    var n = S.answers[t].length;
    if (n >= seq.length) return viewTaskDone();
    var it = seq[n];
    var pct = seq.length ? Math.round(n * 100 / seq.length) : 0;
    return '<section class="taskwrap">' +
      '<div class="taskbar">' +
        '<button class="btn ghost small" id="backHub">← 任务列表</button>' +
        '<div class="taskbar-title"><strong>' + TASK_NAME[t] + '</strong>' +
          '<span class="muted">第 ' + (n + 1) + ' / ' + seq.length + '</span></div>' +
        '<button class="btn ghost small" id="undoBtn" title="撤销上一题（Backspace）">撤销</button>' +
      '</div>' +
      '<div class="progressbar"><i style="width:' + pct + '%"></i></div>' +
      (t === 'id' ? idItemHTML(it) : t === 'dak' ? dakItemHTML(it) : natItemHTML(it)) +
      '<p class="keyhint">' + (t === 'nat' ? '按 1–5 打分' : '按 1–4 作答') +
        ' · Backspace 撤销 · 点击图片可放大</p>' +
      '</section>';
  }

  function idItemHTML(it) {
    return '<div class="item">' +
      '<p class="kicker">红框里更像哪一个？</p>' +
      '<div class="rowimg"><button class="zoomable" data-src="' + imgGen(it.idx) + '" aria-label="放大整行图片">' +
        '<img src="' + imgGen(it.idx) + '" width="420" height="195" alt="生成的四字熟语，红框标出目标格" decoding="async"></button></div>' +
      '<div class="refs">' +
        refFig(imgCond(it.idx), '条件（假名）', '条件参考：假名') +
        refFig(imgPrior(it.idx), '先验（原熟字）', '先验参考：原熟字') +
      '</div>' +
      '<div class="choices" role="group" aria-label="选择答案">' +
        ID_CHOICES.map(function (c) {
          return '<button class="choice" data-ans="' + c.v + '"><kbd>' + c.key + '</kbd>' +
            '<span><b>' + c.label + '</b><em>' + c.sub + '</em></span></button>';
        }).join('') +
      '</div></div>';
  }

  function refFig(src, cap, alt) {
    return '<figure><button class="zoomable" data-src="' + src + '" aria-label="放大' + esc(cap) + '">' +
      '<img src="' + src + '" width="256" height="256" alt="' + esc(alt) + '" loading="lazy" decoding="async">' +
      '</button><figcaption>' + cap + '</figcaption></figure>';
  }

  function dakItemHTML(it) {
    return '<div class="item">' +
      '<p class="kicker">这一格的浊点／半浊点完整吗？</p>' +
      '<div class="rowimg"><button class="zoomable" data-src="' + imgGen(it.idx) + '" aria-label="放大整行图片">' +
        '<img src="' + imgGen(it.idx) + '" width="420" height="195" alt="生成的四字熟语，红框标出目标格" decoding="async"></button></div>' +
      '<div class="dakref">' +
        '<button class="zoomable" data-src="' + imgCond(it.idx) + '" aria-label="放大参考假名">' +
          '<img src="' + imgCond(it.idx) + '" width="256" height="256" alt="带浊点的参考假名" loading="lazy" decoding="async"></button>' +
        '<div><p>应含「' + esc(it.ch) + '」右上角的两点（゛）或小圈（゜）。</p>' +
        '<p class="fine">只看右上角那一小块，不用管字写得像不像。</p></div>' +
      '</div>' +
      '<div class="choices" role="group" aria-label="选择答案">' +
        DAK_CHOICES.map(function (c) {
          return '<button class="choice" data-ans="' + c.v + '"><kbd>' + c.key + '</kbd>' +
            '<span><b>' + c.label + '</b><em>' + c.sub + '</em></span></button>';
        }).join('') +
      '</div></div>';
  }

  function natItemHTML(it) {
    if (!S.natPending || S.natPending.idx !== it.idx) {
      S.natPending = { idx: it.idx, left: null };
    }
    var p = S.natPending;
    var active = p.left == null ? 'L' : 'R';
    function sideFig(side) {
      var isActive = active === side;
      var badge = (side === 'L' && p.left != null) ? '<span class="scorechip">' + p.left + ' 分</span>' : '';
      return '<figure class="pairfig' + (isActive ? ' active' : '') + '">' +
        '<button class="zoomable" data-src="' + imgNat(it.idx, side) + '" aria-label="放大' + (side === 'L' ? '左' : '右') + '图">' +
          '<img src="' + imgNat(it.idx, side) + '" width="460" height="194" alt="待评图 ' + (side === 'L' ? '左' : '右') + '" decoding="async"></button>' +
        '<figcaption>' + (side === 'L' ? '左' : '右') + badge + '</figcaption></figure>';
    }
    return '<div class="item">' +
      '<p class="kicker">同一处文字的两种处理结果，左右位置已随机。请盲评。</p>' +
      '<div class="pair">' + sideFig('L') + sideFig('R') + '</div>' +
      '<div class="ratingbox">' +
        '<p class="ratingtitle">' + (active === 'L' ? '先给左边打分' : '再给右边打分') + '</p>' +
        '<div class="rating" role="group" aria-label="自然度评分">' +
          [1, 2, 3, 4, 5].map(function (v) {
            return '<button class="rate" data-score="' + v + '"><b>' + v + '</b><span>' +
              RATE_LABEL[v] + '</span></button>';
          }).join('') +
        '</div>' +
        '<p class="fine">1 = 一眼假（白边、色块、笔画断裂）　5 = 完全自然，看不出处理痕迹</p>' +
        (p.left != null ? '<button class="linkbtn" id="redoLeft">重打左边</button>' : '') +
      '</div></div>';
  }

  function viewTaskDone() {
    var t = view.task;
    var next = TASKS.filter(function (x) { return answeredCount(x) < totalOf(x); })[0] || null;
    return '<section class="narrow center">' +
      '<div class="check">✓</div>' +
      '<p class="eyebrow">' + TASK_NAME[t] + '</p>' +
      '<h1>这个任务完成了</h1>' +
      '<p class="lead">' + answeredCount(t) + ' 条判断已保存在本机' +
        (backendReady() ? '，并已加入上传队列' : '') + '。</p>' +
      '<div class="rowbtns">' +
        (next ? '<button class="btn primary" data-next="' + next + '">继续：' + TASK_NAME[next] + '</button>' : '') +
        (allDone() ? '<button class="btn primary" id="goDone">查看结果</button>' : '') +
        '<button class="btn ghost" id="backHub">返回任务列表</button>' +
      '</div></section>';
  }

  function viewDone() {
    var total = totalAll();
    var done = answeredAll();
    var pct = total ? Math.round(done * 100 / total) : 0;
    return '<section class="narrow">' +
      '<div class="check">✓</div>' +
      '<h1>全部完成，谢谢！</h1>' +
      '<p class="lead">你完成了 <strong>' + done + '</strong> / ' + total + ' 条判断：' +
        '身份 ' + answeredCount('id') + ' · 浊点 ' + answeredCount('dak') +
        ' · 自然度 ' + answeredCount('nat') + '。</p>' +
      '<div class="progressbar big"><i style="width:' + pct + '%"></i></div>' +
      '<div class="card codecard">' +
        '<p class="muted small">完成码（查询或删除数据时请提供）</p>' +
        '<div class="codebig">' + esc(S.code) + '</div>' +
        '<button class="btn ghost small" id="copyCode">复制完成码</button>' +
      '</div>' +
      '<div class="card syncbox" id="syncBox">' + syncBoxHTML() + '</div>' +
      '<div class="rowbtns">' +
        '<button class="btn primary" id="downloadBtn">下载结果文件</button>' +
        (backendReady() && S.queue.length ? '<button class="btn ghost" id="retryBtn">重新上传</button>' : '') +
        '<button class="btn ghost" id="backHub">返回任务列表</button>' +
      '</div>' +
      '<p class="fine">' + (backendReady()
        ? '显示“已同步”即表示研究者已收到；仍建议保留下载文件作为备份。'
        : '请下载结果文件，并通过页面底部的方式发送给研究者。') +
      '</p></section>';
  }

  /* ------------------------------------------------------------------ 作答 */

  function afterAnswer(task) {
    S.lastTask = task;
    save();
    var total = totalOf(task);
    var n = answeredCount(task);
    var every = Math.max(1, parseInt(CFG.syncEveryN, 10) || 15);
    if (n >= total) {
      submitTask(task, true);
      view.task = task;
      go('taskdone');
      return;
    }
    if (n % every === 0) submitTask(task, false);
    render();
    preloadNext();
  }

  function answerChoice(value) {
    var it = currentItem();
    if (!it) return;
    if (view.task === 'id') {
      S.answers.id.push({
        idx: it.idx, ch: it.ch, dakuten: it.dakuten,
        answer: value, ts: nowISO()
      });
    } else if (view.task === 'dak') {
      S.answers.dak.push({ idx: it.idx, ch: it.ch, answer: value, ts: nowISO() });
    }
    afterAnswer(view.task);
  }

  function answerNat(score) {
    var it = currentItem();
    if (!it) return;
    if (!S.natPending || S.natPending.idx !== it.idx) {
      S.natPending = { idx: it.idx, left: null };
    }
    if (S.natPending.left == null) {
      S.natPending.left = score;
      S.lastTask = 'nat';
      save();
      render();
      return;
    }
    S.answers.nat.push({
      idx: it.idx, left: S.natPending.left, right: score, ts: nowISO()
    });
    S.natPending = null;
    afterAnswer('nat');
  }

  function undo() {
    var t = view.task;
    if (!t) return;
    if (t === 'nat' && S.natPending && S.natPending.left != null) {
      S.natPending = null;
      save();
      render();
      toast('已清除左边的打分');
      return;
    }
    if (!S.answers[t].length) {
      toast('还没有可撤销的作答');
      return;
    }
    S.answers[t].pop();
    if (t === 'nat') S.natPending = null;
    save();
    submitTask(t, answeredCount(t) >= totalOf(t));
    render();
    toast('已撤销上一题');
  }

  function leaveTask() {
    var t = view.task;
    if (t) {
      var n = answeredCount(t);
      if (n > S.lastSnapshot[t]) submitTask(t, n >= totalOf(t));
      S.lastTask = t;
      save();
    }
    go('hub');
  }

  function finalize() {
    if (!allDone()) { toast('还有任务没有完成'); return; }
    if (!S.finishedAt) S.finishedAt = nowISO();
    TASKS.forEach(function (t) {
      if (S.lastSnapshot[t] !== S.answers[t].length) submitTask(t, true);
    });
    save();
    go('done');
    flush();
  }

  function preloadNext() {
    var seq = taskItems(view.task);
    var next = seq[S.answers[view.task].length];
    if (!next) return;
    var srcs = [imgGen(next.idx), imgCond(next.idx)];
    if (view.task === 'nat') srcs = [imgNat(next.idx, 'L'), imgNat(next.idx, 'R')];
    srcs.forEach(function (src) { var im = new Image(); im.src = src; });
  }

  /* ------------------------------------------------------------------ 缩放 */

  function openZoom(src, alt) {
    if (!zoomEl) return;
    zoomImg.src = src;
    zoomImg.alt = alt || '题目图片';
    zoomEl.hidden = false;
    document.body.classList.add('zoomed');
  }

  function closeZoom() {
    if (!zoomEl) return;
    zoomEl.hidden = true;
    zoomImg.removeAttribute('src');
    document.body.classList.remove('zoomed');
  }

  /* ------------------------------------------------------------------ 下载 */

  function downloadResults() {
    if (!S) return;
    var tasks = {};
    TASKS.forEach(function (t) {
      tasks[t] = { total: totalOf(t), answered: answeredCount(t), done: answeredCount(t) >= totalOf(t) };
    });
    var payload = {
      study: 'MIXIDIOM-69',
      schema: SCHEMA,
      version: CFG.version,
      session_id: S.sessionId,
      code: S.code,
      consent: S.consent,
      started_at: S.startedAt,
      finished_at: S.finishedAt,
      exported_at: nowISO(),
      demographics: S.demographics,
      tasks: tasks,
      answers: S.answers,
      nat_pending: S.natPending
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'glyphgen_' + S.code + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
    toast('结果文件已开始下载');
  }

  /* ------------------------------------------------------------------ 事件 */

  function startNew() {
    S = newSession();
    save();
    go('welcome');
  }

  function restartConfirmed() {
    if (!window.confirm('确定清除本机上的当前进度并重新开始？此操作不可撤销，已上传的数据不受影响。')) return false;
    try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
    S = null;
    sync.lastOk = 0;
    sync.error = '';
    go('welcome');
    return true;
  }

  function onDigit(n) {
    if (view.screen !== 'task') return;
    var t = view.task;
    if (t === 'id') {
      var c = ID_CHOICES.filter(function (x) { return x.key === n; })[0];
      if (c) answerChoice(c.v);
    } else if (t === 'dak') {
      var d = DAK_CHOICES.filter(function (x) { return x.key === n; })[0];
      if (d) answerChoice(d.v);
    } else if (t === 'nat' && n >= 1 && n <= 5) {
      answerNat(n);
    }
  }

  function wireGlobal() {
    app.addEventListener('click', function (e) {
      var t = e.target;
      function pick(sel) { return t.closest(sel); }
      var el;

      if ((el = pick('.zoomable'))) {
        e.preventDefault();
        var im = el.querySelector('img');
        openZoom(el.getAttribute('data-src'), im ? im.alt : '');
        return;
      }
      if ((el = pick('#startBtn'))) {
        e.preventDefault();
        if (!S) { S = newSession(); S.consent = true; save(); }
        go('demo');
        return;
      }
      if ((el = pick('#backWelcome'))) {
        e.preventDefault();
        if (S && !S.demographics) {
          S = null;
          try { localStorage.removeItem(STORE); } catch (err) { /* ignore */ }
        }
        go('welcome');
        return;
      }
      if ((el = pick('#resumeBtn'))) {
        e.preventDefault();
        if (S.lastTask && answeredCount(S.lastTask) < totalOf(S.lastTask)) {
          go('task', { task: S.lastTask });
        } else {
          go('hub');
        }
        return;
      }
      if ((el = pick('#restartBtn')) || (el = pick('#restart2'))) {
        e.preventDefault();
        restartConfirmed();
        return;
      }
      if ((el = pick('[data-task]'))) {
        e.preventDefault();
        var task = el.getAttribute('data-task');
        view.task = task;
        if (answeredCount(task) >= totalOf(task)) go('taskdone');
        else go('task');
        return;
      }
      if ((el = pick('[data-ans]'))) {
        e.preventDefault();
        answerChoice(el.getAttribute('data-ans'));
        return;
      }
      if ((el = pick('[data-score]'))) {
        e.preventDefault();
        answerNat(parseInt(el.getAttribute('data-score'), 10));
        return;
      }
      if ((el = pick('[data-next]'))) {
        e.preventDefault();
        go('task', { task: el.getAttribute('data-next') });
        return;
      }
      if ((el = pick('#undoBtn'))) {
        e.preventDefault();
        undo();
        return;
      }
      if ((el = pick('#redoLeft'))) {
        e.preventDefault();
        if (S.natPending) S.natPending.left = null;
        save();
        render();
        return;
      }
      if ((el = pick('#backHub'))) {
        e.preventDefault();
        if (view.screen === 'task') leaveTask();
        else go('hub');
        return;
      }
      if ((el = pick('#finishBtn'))) {
        e.preventDefault();
        if (!el.disabled) finalize();
        return;
      }
      if ((el = pick('#goDone'))) {
        e.preventDefault();
        go('done');
        return;
      }
      if ((el = pick('#downloadBtn'))) {
        e.preventDefault();
        downloadResults();
        return;
      }
      if ((el = pick('#retryBtn'))) {
        e.preventDefault();
        toast('正在重试上传…');
        sync.retryTimer && clearTimeout(sync.retryTimer);
        flush();
        return;
      }
      if ((el = pick('#copyCode')) || (el = pick('#copyCodeTop'))) {
        e.preventDefault();
        copyText(S.code, '完成码已复制：' + S.code);
        return;
      }
    });

    app.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'consentBox') {
        var btn = document.getElementById('startBtn');
        if (btn) btn.disabled = !e.target.checked;
      }
    });

    app.addEventListener('submit', function (e) {
      if (!e.target || e.target.id !== 'demoForm') return;
      e.preventDefault();
      var form = e.target;
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var fd = new FormData(form);
      if (!S) { S = newSession(); S.consent = true; }
      S.demographics = {
        native_lang: String(fd.get('native_lang') || ''),
        kana: String(fd.get('kana') || ''),
        age: String(fd.get('age') || ''),
        prior: String(fd.get('prior') || ''),
        contact: String(fd.get('contact') || '').trim().slice(0, 120)
      };
      S.consent = true;
      save();
      enqueue('participants', participantBody());
      go('hub');
    });

    document.addEventListener('keydown', function (e) {
      if (view.screen !== 'task') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Backspace') { e.preventDefault(); undo(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeZoom(); return; }
      if (/^[1-5]$/.test(e.key)) { e.preventDefault(); onDigit(parseInt(e.key, 10)); }
    });

    if (zoomEl) {
      zoomEl.addEventListener('click', function (e) {
        e.preventDefault();
        closeZoom();
      });
    }

    if (topStatusEl) {
      topStatusEl.addEventListener('click', function (e) {
        var b = e.target.closest('#copyCodeTop');
        if (b) {
          e.preventDefault();
          if (S) copyText(S.code, '完成码已复制：' + S.code);
        }
      });
    }

    window.addEventListener('online', function () { flush(); });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') saveOnHide();
    });
    window.addEventListener('pagehide', saveOnHide);

    setInterval(function () {
      if (S && S.queue.length && backendReady() && navigator.onLine) flush();
    }, 60000);
  }

  function saveOnHide() {
    if (!S) return;
    save();
    if (view.screen === 'task' && view.task) {
      var n = answeredCount(view.task);
      if (n > S.lastSnapshot[view.task]) {
        submitTask(view.task, n >= totalOf(view.task));
      }
    }
    if (S.queue.length && backendReady() && navigator.onLine) flush();
  }

  /* ------------------------------------------------------------------ 启动 */

  function applyConfig() {
    var link = document.getElementById('footContact');
    if (!link) return;
    if (CFG.contactEmail) {
      link.href = 'mailto:' + CFG.contactEmail;
      link.textContent = '联系研究者（' + CFG.contactEmail + '）';
    } else if (CFG.contactUrl) {
      link.href = CFG.contactUrl;
    }
  }

  function init() {
    applyConfig();
    wireGlobal();
    app.innerHTML = viewBoot('正在加载素材…');
    fetch('./data/items.json', { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      DATA = data;
      ITEMS = (data.items || []).slice().sort(function (a, b) { return a.idx - b.idx; });
      DAK_ITEMS = ITEMS.filter(function (x) { return x.dakuten; });
      if (!ITEMS.length) throw new Error('items.json 为空');
      S = load();
      if (!S) {
        go('welcome');
      } else if (!S.demographics) {
        go('demo');
      } else if (allDone()) {
        go('done');
      } else if (answeredAll() === 0) {
        go('hub');
      } else {
        go('resume');
      }
      if (S && S.queue.length && backendReady()) flush();
    }).catch(function (err) {
      app.innerHTML = viewBootError(err);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
