/* ============================================================================
 * ai.js — 浏览器本地 AI 助手（WebLLM / WebGPU）
 * ----------------------------------------------------------------------------
 * 设计目标（契合用户诉求：免费、不想折腾 key、不想管后端）：
 *   · 模型在用户手机/电脑的浏览器里本地运行（WebGPU），数据不出设备、隐私好
 *   · 首次使用从 CDN 下载一次模型（约 1.5GB），之后断网也能用
 *   · 不需要任何 API key、不需要后端服务器、不需要账号
 *
 * 覆盖的编辑场景：
 *   ✍️ 写今日行程介绍  → 写入 day.desc（当日说明，带 ✨ 标记可识别）
 *   🏞️ 给景点写贴士    → 写入 stop.note
 *   🏨 补酒店信息      → 写入 hotel.note
 *   🚄 写交通提醒      → 写入 ticket.note
 *   📔 手账配图文案    → 写入 journal.note
 *
 * 关于「照片→AI 绘画」：浏览器本地目前跑不了图像生成模型（需云端图像 API +
 * key + 后端），本文件不实现；手账已有的「水彩化」是本地 Canvas 风格滤镜。
 * ========================================================================== */
(function () {
  'use strict';

  // 候选模型链（按顺序尝试，前一个加载失败自动换下一个）：
  //   ① 3B q4f16 —— 质量最好（约 2.5GB 显存）
  //   ② 1.5B q4f32 —— 部分 Android GPU（如 Adreno）f16 驱动有 bug 会导致
  //      "GPUBuffer was unmapped before mapping was resolved"，f32 可规避
  //   ③ 1.5B q4f16 —— 显存最小（约 1.6GB），显存不足的设备兜底
  var MODEL_CANDIDATES = [
    'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'
  ];
  // 钉住版本：避免 CDN 自动升级后内部字段变化导致隐性崩坏
  var LIB_URL = 'https://esm.run/@mlc-ai/web-llm@0.2.85';

  /* 模型权重下载源（按顺序尝试）
     —— 关键：huggingface.co 在国内几乎不可达（Failed to fetch）；
        hf-mirror.com 只镜像元数据，真实权重会被 302 到 xethub（同样不可达）。
        实测 ModelScope（阿里，国内直连）完整托管了 MLC 格式权重，首选它。 */
  var MODEL_BASES = [
    'https://www.modelscope.cn/models/mlc-ai/\u0000/resolve/master', // ① 国内首选（直连实测可下）
    'https://hf-mirror.com/mlc-ai/\u0000/resolve/main',              // ② 海外镜像兜底
    'https://huggingface.co/mlc-ai/\u0000/resolve/main'              // ③ 官方源兜底
  ];
  // \u0000 是占位符，构建时替换成 model_id
  function baseUrl(tpl, modelId) { return tpl.replace('\u0000', modelId); }

  var WebLLM = null;       // 动态加载的库
  var engine = null;       // 已初始化的引擎
  var loading = false;     // 是否正在加载引擎
  var mockFn = null;       // 测试用：返回假回复，绕过 WebGPU + 下载
  var pending = null;      // 待采纳的动作上下文 { act, targetId }
  var lastText = '';       // 最近一次生成结果

  /* ----------------------------- 工具 ----------------------------- */
  function $(id) { return document.getElementById(id); }

  function hasWebGPU() { return !!(navigator.gpu); }

  function setStatus(txt, cls) {
    var el = $('aiStatus');
    if (el) { el.textContent = txt; el.className = 'ai-status' + (cls ? ' ' + cls : ''); }
  }
  function setProgress(p) {
    var bar = $('aiProgress');
    if (bar) {
      var pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
      bar.style.width = pct + '%';
      bar.textContent = pct + '%';
    }
  }
  function showOut(text) {
    var box = $('aiOut');
    if (box) box.style.display = 'block';
    var t = $('aiOutText');
    if (t) t.textContent = text || '';
  }
  function hideTarget() {
    var t = $('aiTarget'); if (t) t.style.display = 'none';
    var g = $('aiGen'); if (g) g.style.display = 'none';
  }

  /* --------------------------- 加载引擎 --------------------------- */
  async function loadLib() {
    if (WebLLM) return WebLLM;
    setStatus('正在加载 AI 引擎库…');
    try {
      WebLLM = await import(/* @vite-ignore */ LIB_URL);
    } catch (e) {
      setStatus('引擎库加载失败，请检查网络后重试', 'err');
      throw e;
    }
    return WebLLM;
  }

  async function getEngine() {
    if (engine) return engine;
    if (mockFn) {
      // 测试钩子：返回假引擎，不依赖 WebGPU / 下载
      engine = {
        chat: { completions: { create: async function (opts) {
          var userMsg = (opts.messages || []).filter(function (m) { return m.role === 'user'; }).pop();
          var full = mockFn(userMsg ? userMsg.content : '');
          var out = '';
          // 模拟流式
          var chunks = full.match(/[\s\S]{1,4}/g) || [full];
          for (var i = 0; i < chunks.length; i++) {
            out += chunks[i];
            await new Promise(function (r) { setTimeout(r, 4); });
            var cb = opts.onToken; if (cb) cb(out);
          }
          return { choices: [{ delta: { content: out } }] };
        } } }
      };
      setStatus('就绪 ✅（测试模式）', 'ok');
      return engine;
    }
    if (!hasWebGPU()) {
      setStatus('当前浏览器不支持 WebGPU（需 Chrome / Edge 113+ 或安卓 Chrome）。可改用云端版。', 'err');
      throw new Error('NO_WEBGPU');
    }
    if (loading) throw new Error('LOADING');
    loading = true;
    try {
      var lib = await loadLib();
      setStatus('首次使用需下载模型（约 1.5GB，仅一次）…');
      setProgress(0);

      /* 构造自定义 appConfig：把模型的下载地址指到国内源。
         默认配置写死 huggingface.co，国内会 Failed to fetch。
         这里基于 prebuiltAppConfig 拷贝一份，替换 model_list 里的 model_url。 */
      var baseCfg = lib.prebuiltAppConfig || {};
      var srcList = (baseCfg.model_list && baseCfg.model_list.length) ? baseCfg.model_list : [];

      var lastErr = null;
      // 依次尝试候选模型（前一个失败=当前设备跑不动/驱动不兼容，自动降级）
      for (var c = 0; c < MODEL_CANDIDATES.length; c++) {
        var modelId = MODEL_CANDIDATES[c];
        if (c > 0) {
          setProgress(0);
          setStatus('当前设备跑不动上一个模型，自动换用更小的模型重试…（' + (c + 1) + '/' + MODEL_CANDIDATES.length + '）', 'warn');
        }
        // 依次尝试每个下载源
        for (var i = 0; i < MODEL_BASES.length; i++) {
          try {
            if (i > 0) { setStatus('换备用下载源重试…'); setProgress(0); }
            var base = baseUrl(MODEL_BASES[i], modelId);
            /* 注意：WebLLM 的 ModelRecord 字段名是 model（权重目录 URL），
               不是 model_url —— 写错字段名会导致引擎读到 undefined，
               在内部 url.endsWith("/") 处抛
               "Cannot read properties of undefined (reading 'endsWith')"。 */
            var modelList = srcList.map(function (m) {
              if (m.model_id !== modelId) return m;
              return {
                model_id: m.model_id,
                model_lib: m.model_lib,
                model: base + '/',
                vram_required_MB: m.vram_required_MB,
                low_resource_required: m.low_resource_required,
                overrides: m.overrides
              };
            });
            // 若库未提供 model_list，构造最小可用配置
            if (!modelList.length) {
              modelList = [{ model_id: modelId, model: base + '/' }];
            }
            engine = await lib.CreateMLCEngine(modelId, {
              appConfig: { model_list: modelList, useIndexedDBCache: true },
              initProgressCallback: function (report) {
                var p = (report && report.progress) || 0;
                setProgress(p);
                var txt = (report && report.text) || '';
                setStatus((txt ? txt.slice(0, 42) + ' … ' : '下载模型中… ') + Math.round(p * 100) + '%');
              }
            });
            setStatus('就绪 ✅', 'ok');
            setProgress(1);
            return engine;
          } catch (e) {
            lastErr = e;
            console.warn('[AI] 加载失败（模型 ' + modelId + '，源 ' + (i + 1) + '）：', baseUrl(MODEL_BASES[i], modelId), e && e.message);
          }
        }
      }
      // 全部候选 × 全部源都失败
      setStatus('模型加载失败（已尝试多个模型与下载源）。请检查网络或重启浏览器后重试。', 'err');
      throw lastErr || new Error('DOWNLOAD_FAILED');
    } catch (e) {
      if (String(e && e.message) === 'NO_WEBGPU') { /* 已提示 */ }
      else if (String(e && e.message) === 'LOADING') { setStatus('正在下载中，请稍候…', 'warn'); }
      else if (String(e && e.message) === 'DOWNLOAD_FAILED') { /* 上面已给出明确提示 */ }
      else {
        setStatus('加载失败：' + (e && e.message ? String(e.message).slice(0, 60) : e) + '（可再点功能重试）', 'err');
      }
      throw e;
    } finally {
      loading = false;
    }
  }

  /* --------------------------- 生成（流式） --------------------------- */
  async function generate(system, user, onToken) {
    var eng = await getEngine();
    var resp = await eng.chat.completions.create({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      stream: true,
      temperature: 0.7,
      max_tokens: 512
    });
    // 兼容 WebLLM 的异步迭代器流式返回
    var out = '';
    if (resp && typeof resp[Symbol.asyncIterator] === 'function') {
      for await (var chunk of resp) {
        var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (d) { out += d; if (onToken) onToken(out); }
      }
    } else if (resp && resp.choices && resp.choices[0] && resp.choices[0].delta) {
      // 非流式兜底（测试钩子返回的结构）
      out = resp.choices[0].delta.content || '';
      if (onToken) onToken(out);
    }
    return out;
  }

  /* --------------------------- 数据读取 --------------------------- */
  function dayText(d) {
    if (!d) return '';
    var stops = (d.stops || []).map(function (s) {
      return s.name + (s.duration ? '（约' + s.duration + '）' : '');
    }).join('、');
    return '日期：' + (d.date || '?') + '\n标题：' + (d.title || '未命名') +
           '\n角色：' + (d.stops && d.stops.length ? '游玩日' : '交通/中转日') +
           '\n景点：' + (stops || '无');
  }
  function ticketTypeText(t) {
    var m = { flight: '飞机', train: '火车', bus: '大巴', car: '自驾', ship: '轮船' };
    return m[t.type] || (t.type || '交通');
  }

  /* --------------------------- 提示词构建 --------------------------- */
  function buildPrompt(act, target) {
    if (act === 'day') {
      var d = activeDay();
      return {
        system: '你是一个旅行助手，用简洁、有人情味的中文为游客撰写「当日引导语」。2-3 句话，点出当天的主题与节奏，加一句实用提醒；口语化，不要堆砌景点名，不要使用 Markdown。',
        user: '请为下面这一天的行程写一段当日引导语：\n' + dayText(d)
      };
    }
    if (act === 'stop') {
      var stop = findStop(target);
      return {
        system: '你是资深旅行向导。针对单个景点写一段实用游玩贴士（3-5 句，含怎么玩/最佳时间/注意事项/避坑），口语化，不用 Markdown。',
        user: '请为景点「' + stop.name + '」写贴士。\n已有信息：' + (stop.note || '无')
      };
    }
    if (act === 'hotel') {
      var h = DB.hotels.find(function (x) { return x.id === target; });
      return {
        system: '你是酒店助手。为一家酒店补充实用信息（3-5 句，含位置/设施/周边/适合人群），口语化，不要编造具体价格，不用 Markdown。',
        user: '酒店：' + h.name + '\n地址：' + (h.address || '未知') +
              '\n入住：' + (h.checkIn || '?') + ' 退房：' + (h.checkOut || '?') +
              '\n已有备注：' + (h.note || '无')
      };
    }
    if (act === 'ticket') {
      var t = DB.tickets.find(function (x) { return x.id === target; });
      return {
        system: '你是出行助手。为一段交通写一段出行提醒（3-5 句，含取票/安检/中转/携带物品/提前量），口语化，不用 Markdown。',
        user: '交通：' + ticketTypeText(t) + ' ' + (t.from || '?') + ' → ' + (t.to || '?') +
              '\n日期：' + (t.date || '?') + ' 出发：' + (t.depTime || '?') +
              '\n已有备注：' + (t.note || '无')
      };
    }
    if (act === 'journal') {
      var j = DB.journals.find(function (x) { return x.id === target; });
      return {
        system: '你是手账作者。为一张旅行照片写一段有画面感、温暖、适合写在手账里的配图文案（1-3 句），中文，不用 Markdown。',
        user: '主题：' + (j.title || '未命名手账') + '\n已有文字：' + (j.note || '无')
      };
    }
    return { system: '', user: '' };
  }

  function findStop(id) {
    // 在当前行程的全部天里找 stop
    for (var i = 0; i < DB.days.length; i++) {
      var st = (DB.days[i].stops || []).find(function (x) { return x.id === id; });
      if (st) return st;
    }
    return null;
  }

  /* --------------------------- 动作分发 --------------------------- */
  function runAction(act, target) {
    // 记住本次「动作 + 目标」，供 adopt() 精确写回
    // （不要在切换动作时清空，否则生成结果无法写回正确对象）
    pending = { act: act, targetId: target };
    var p = buildPrompt(act, target);
    if (!p.user) { setStatus('没有可用数据，请先完善行程', 'err'); return; }
    $('aiOut').style.display = 'none';
    setStatus('正在生成…');
    setProgress(1);
    generate(p.system, p.user, function (partial) { showOut(partial); })
      .then(function (full) {
        lastText = (full || '').trim();
        showOut(lastText);
        setStatus('生成完成，可「采纳」写入', 'ok');
        setProgress(1);
      })
      .catch(function (e) {
        if (String(e && e.message) === 'NO_WEBGPU') return; // 已提示
        setStatus('生成失败：' + (e && e.message ? e.message : e), 'err');
      });
  }

  /* --------------------------- 采纳写回 --------------------------- */
  function adopt() {
    if (!pending || !lastText) { toast('没有可采纳的内容', 'warn'); return; }
    var act = pending.act, id = pending.targetId;
    var ai = '✨ ' + lastText;
    if (act === 'day') {
      var d = activeDay();
      if (d) {
        d.desc = (d.desc || []).filter(function (t) { return !/^✨/.test(t); });
        d.desc.unshift(ai);
      }
    } else if (act === 'stop') {
      var s = findStop(id);
      if (s) s.note = (s.note && !/^✨/.test(s.note) ? s.note + '\n' : '') + ai;
    } else if (act === 'hotel') {
      var h = DB.hotels.find(function (x) { return x.id === id; });
      if (h) h.note = (h.note && !/^✨/.test(h.note) ? h.note + '\n' : '') + ai;
    } else if (act === 'ticket') {
      var t = DB.tickets.find(function (x) { return x.id === id; });
      if (t) t.note = (t.note && !/^✨/.test(t.note) ? t.note + '\n' : '') + ai;
    } else if (act === 'journal') {
      var j = DB.journals.find(function (x) { return x.id === id; });
      if (j) j.note = (j.note && !/^✨/.test(j.note) ? j.note + '\n' : '') + ai;
    }
    save();
    renderAll();
    toast('已写入并保存 ✅', 'ok');
    setStatus('已采纳，可继续编辑或关闭', 'ok');
  }

  /* --------------------------- UI 绑定 --------------------------- */
  function fillTargets(act) {
    var sel = $('aiTargetSel');
    if (!sel) return;
    sel.innerHTML = '';
    var items = [];
    if (act === 'stop') {
      DB.days.forEach(function (d, di) {
        (d.stops || []).forEach(function (s) {
          items.push({ id: s.id, label: 'D' + (di + 1) + ' ' + s.name });
        });
      });
    } else if (act === 'hotel') {
      (DB.hotels || []).forEach(function (h) { items.push({ id: h.id, label: h.name }); });
    } else if (act === 'ticket') {
      (DB.tickets || []).forEach(function (t) {
        items.push({ id: t.id, label: ticketTypeText(t) + ' ' + (t.from || '') + '→' + (t.to || '') });
      });
    } else if (act === 'journal') {
      (DB.journals || []).forEach(function (j) { items.push({ id: j.id, label: j.title || '未命名手账' }); });
    }
    if (!items.length) {
      setStatus('当前没有可选的' + ({ stop: '景点', hotel: '酒店', ticket: '交通', journal: '手账' }[act] || '对象'), 'err');
      return false;
    }
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = it.id; o.textContent = it.label; sel.appendChild(o);
    });
    return true;
  }

  function onActionClick(act) {
    hideTarget();
    $('aiOut').style.display = 'none';
    if (act === 'day') {
      if (!activeDay()) { setStatus('请先选择一天', 'err'); return; }
      runAction('day');
      return;
    }
    if (fillTargets(act)) {
      $('aiTarget').style.display = 'block';
      var g = $('aiGen');
      g.style.display = 'inline-block';
      g.dataset.act = act;          // 记住当前动作，点击「开始生成」时用它
    }
  }

  function openModal() {
    var m = $('aiMask'); if (m) m.classList.add('show');
    if (!hasWebGPU() && !mockFn) {
      setStatus('提示：检测不到 WebGPU，可能无法在本地运行模型（需 Chrome/Edge 113+）。', 'warn');
    } else if (!engine && !loading) {
      setStatus('点击上方功能即可开始（首次会下载模型）');
    }
  }
  function closeModal() {
    var m = $('aiMask'); if (m) m.classList.remove('show');
  }

  function init() {
    var fab = $('aiFab');
    if (fab) fab.onclick = openModal;
    var close = $('aiClose'); if (close) close.onclick = closeModal;
    var mask = $('aiMask');
    if (mask) mask.onclick = function (e) { if (e.target === mask) closeModal(); };

    var actions = document.querySelectorAll('#aiActions .ai-act');
    Array.prototype.forEach.call(actions, function (b) {
      b.onclick = function () { onActionClick(b.dataset.act); };
    });
    var gen = $('aiGen'); if (gen) gen.onclick = function () {
      var act = $('aiGen').dataset.act;
      if (act) runAction(act, $('aiTargetSel').value);
    };
    var adoptBtn = $('aiAdopt'); if (adoptBtn) adoptBtn.onclick = adopt;
    var copyBtn = $('aiCopy'); if (copyBtn) copyBtn.onclick = function () {
      if (lastText) { navigator.clipboard && navigator.clipboard.writeText(lastText); toast('已复制', 'ok'); }
    };
    var retry = $('aiRetry'); if (retry) retry.onclick = function () {
      if (!pending) return;
      if (pending.act === 'day') runAction('day');
      else runAction(pending.act, $('aiTargetSel').value);
    };
    // Esc 关闭
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }

  // 暴露测试钩子 + 状态接口
  window.TPAI = {
    init: init,
    open: openModal,
    close: closeModal,
    run: runAction,
    adopt: adopt,
    getEngine: getEngine,
    status: function () { return { ready: !!engine, loading: loading, webgpu: hasWebGPU() }; },
    __setMock: function (fn) { mockFn = fn; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
