/* 音乐库抽屉：歌曲 / 专辑 / 艺术家 / 歌单 / 设置 五个页签
   所有页面共用一份曲库数据，切页签只重绘不重新扫描。 */
import { esc, fmt } from '../core/util.js';
import { qualityOf, levelInfo, LEVELS, fmtBytes, fmtDuration, libraryStats, groupBy } from '../core/quality.js';
import { allTrackStats, summary } from '../core/stats.js';

const TABS = ['tracks', 'albums', 'artists', 'playlists', 'settings'];

export class Library {
  constructor(o){
    this.sheet = o.sheet;
    this.scrim = o.scrim;
    this.list = o.list;
    this.count = o.count;
    this.hint = o.hint;
    this.pickBtn = o.pickBtn;
    this.rescanBtn = o.rescanBtn;
    this.lrcBtn = o.lrcBtn;
    this.closeBtn = o.closeBtn;
    this.tabsEl = o.tabs;
    this.titleEl = o.title;
    this.panes = o.panes || {};
    this.lists = o.lists || {};
    this.hooks = o.hooks;

    this.tracks = [];
    this.index = -1;
    this.playing = false;
    this.open_ = false;
    this.tab = 'tracks';
    this.drill = null;      // { kind:'album'|'artist'|'playlist', key, name }
    this.playlists = [];
    this.libraryInfo = {};
    this.query = '';
    this.view = 'lyrics';
    this.volume = .72;
    this.keepOn = false;
    this.hideBar = false;

    this.searchInput = o.searchInput || null;
    this.searchClear = o.searchClear || null;

    this.pickBtn.addEventListener('click', () => this.hooks.onPick());
    this.rescanBtn.addEventListener('click', () => this.hooks.onRescan());
    this.closeBtn.addEventListener('click', () => this.close());
    this.scrim.addEventListener('click', () => this.close());
    if (this.lrcBtn) this.lrcBtn.addEventListener('click', () => this.hooks.onImportLyrics());
    if (o.newPlBtn) o.newPlBtn.addEventListener('click', () => this.hooks.onCreatePlaylist());

    if (this.searchInput){
      this.searchInput.addEventListener('input', () => this.setQuery(this.searchInput.value));
      this.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape'){
          e.stopPropagation();
          if (this.query) this.setQuery('');
          else this.close();
        } else if (e.key === 'Enter'){
          e.preventDefault();
          this.searchInput.blur();
          const first = this.list.querySelector('.tr:not(.unsupported)');
          if (first) first.click();
        }
      });
    }
    if (this.searchClear){
      this.searchClear.addEventListener('click', () => {
        this.setQuery('');
        if (this.searchInput) this.searchInput.focus();
      });
    }

    this.tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      this.setTab(b.dataset.tab);
    });

    this.list.addEventListener('click', (e) => this.onListClick(e));
    this.lists.albums.addEventListener('click', (e) => this.onGroupClick(e, 'album'));
    this.lists.artists.addEventListener('click', (e) => this.onGroupClick(e, 'artist'));
    this.lists.playlists.addEventListener('click', (e) => this.onPlaylistClick(e));
    this.lists.settings.addEventListener('click', (e) => this.onSettingsClick(e));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open_){
        if (this.drill){ this.drill = null; this.redraw(); }
        else this.close();
      }
    });
  }

  get isOpen(){ return this.open_; }

  open(){
    this.open_ = true;
    this.sheet.classList.add('open');
    this.scrim.classList.add('open');
    this.sheet.setAttribute('aria-hidden', 'false');
    const cur = this.list.querySelector('.tr.is-cur');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  close(){
    this.open_ = false;
    this.sheet.classList.remove('open');
    this.scrim.classList.remove('open');
    this.sheet.setAttribute('aria-hidden', 'true');
  }

  toggle(){ this.open_ ? this.close() : this.open(); }

  setBusy(busy){
    this.pickBtn.disabled = busy;
    this.rescanBtn.disabled = busy;
    this.hint.textContent = busy ? '正在扫描…' : '';
  }

  setTab(name){
    if (!TABS.includes(name)) return;
    this.tab = name;
    this.drill = null;
    for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.tab === name);
    for (const k of TABS) this.panes[k].classList.toggle('on', k === name);
    this.redraw();
  }

  /* ---------------- 搜索 ---------------- */

  /* 标题 / 艺人 / 专辑 / 文件名，任意命中即可 */
  match(t){
    const q = this.query;
    if (!q) return true;
    return (t.title || '').toLowerCase().includes(q) ||
           (t.artist || '').toLowerCase().includes(q) ||
           (t.album || '').toLowerCase().includes(q) ||
           (t.format || '').toLowerCase().includes(q);
  }

  filtered(){
    return this.query ? this.tracks.filter(t => this.match(t)) : this.tracks;
  }

  setQuery(q){
    const v = (q || '').trim().toLowerCase();
    if (v === this.query){
      if (this.searchClear) this.searchClear.hidden = !v;
      return;
    }
    this.query = v;
    if (this.searchClear) this.searchClear.hidden = !v;
    if (this.searchInput && this.searchInput.value.trim().toLowerCase() !== v){
      this.searchInput.value = q || '';
    }
    // 搜索只在歌曲/专辑/艺术家三页有意义，停在设置页时顺手切回歌曲
    if (v && (this.tab === 'settings' || this.tab === 'playlists')) this.setTab('tracks');
    else this.redraw();
  }

  focusSearch(){
    if (this.searchInput) this.searchInput.focus();
  }

  /* ---------------- 数据入口 ---------------- */

  render(tracks, index, playing, opts){
    this.tracks = tracks || [];
    this.index = index;
    this.playing = !!playing;
    this.opts = opts || {};
    if (this.opts.playlists) this.playlists = this.opts.playlists;
    if (this.opts.libraryInfo) this.libraryInfo = this.opts.libraryInfo;
    if (this.opts.view) this.view = this.opts.view;
    if (this.opts.volume != null) this.volume = this.opts.volume;
    if (this.opts.keepOn != null) this.keepOn = !!this.opts.keepOn;
    if (this.opts.hideBar != null) this.hideBar = !!this.opts.hideBar;

    if (this.lrcBtn) this.lrcBtn.hidden = !this.opts.showLrcImport;
    this.count.textContent = this.tracks.length ? this.tracks.length + ' 首' : '';

    this.redraw();
  }

  redraw(){
    this.renderTracks();
    this.renderAlbums();
    this.renderArtists();
    this.renderPlaylists();
    this.renderSettings();
    this.syncTitle();
  }

  syncTitle(){
    const base = { tracks: '音乐库', albums: '专辑', artists: '艺术家', playlists: '歌单', settings: '设置' };
    let t = base[this.tab] || '音乐库';
    if (this.drill && this.drill.name) t = this.drill.name;
    this.titleEl.firstChild.textContent = t;
  }

  /* ---------------- 歌曲 ---------------- */

  renderTracks(){
    const o = this.opts || {};
    if (!this.tracks.length){
      this.list.innerHTML =
        '<div class="lib-empty"><b>还没有曲目</b>' +
        (o.emptyHint || '选择一个放音乐的文件夹，它会把里面的歌整理成一张唱片。') +
        '</div>';
      return;
    }
    const list = this.filtered();
    if (!list.length){
      this.list.innerHTML =
        '<div class="lib-empty"><b>没有匹配的曲目</b>' +
        '「' + esc(this.rawQuery()) + '」在标题、艺人和专辑里都没找到。' +
        '</div>';
      return;
    }
    this.list.innerHTML = this.trackRows(list, true);
  }

  rawQuery(){
    return (this.searchInput && this.searchInput.value.trim()) || this.query;
  }

  trackRows(list, numbered){
    const stats = allTrackStats();
    return list.map((t) => {
      const i = this.tracks.indexOf(t);
      const cur = i >= 0 && i === this.index ? ' is-cur' : '';
      const on = cur && this.playing ? ' is-on' : '';
      const bad = t.playable === false ? ' unsupported' : '';
      const dur = t.duration ? fmt(t.duration) : '--:--';
      const st = stats[t.id];
      const lv = levelInfo(qualityOf(t));
      return '<div class="tr' + cur + on + bad + '" data-i="' + i + '">' +
        '<span class="tr-n">' + (cur ? '▶' : numbered ? String(i + 1).padStart(2, '0') : '·') + '</span>' +
        '<span class="tr-body">' +
          '<span class="tr-t">' + esc(t.title || '未知曲目') +
            '<i class="badge" style="--c:' + lv.color + '">' + lv.name + '</i>' +
          '</span>' +
          '<span class="tr-a">' + esc([t.artist, t.album].filter(Boolean).join(' · ') || ' ') +
            (st && st.n ? ' · 播放 ' + st.n + ' 次' : '') +
          '</span>' +
        '</span>' +
        '<span class="eqmini"><i></i><i></i><i></i></span>' +
        '<span class="tr-add" data-add="' + esc(t.id) + '" title="加入歌单" role="button">+</span>' +
        '<span class="tr-d">' + dur + '</span>' +
      '</div>';
    }).join('');
  }

  onListClick(e){
    const add = e.target.closest('[data-add]');
    if (add){
      e.stopPropagation();
      this.hooks.onAddToPlaylist(add.dataset.add);
      return;
    }
    const row = e.target.closest('.tr');
    if (!row) return;
    const i = +row.dataset.i;
    if (i < 0) return;
    if (row.classList.contains('unsupported')){
      this.hooks.onUnsupported(this.tracks[i]);
      return;
    }
    this.hooks.onPlay(i);
    if (window.matchMedia('(orientation:portrait)').matches) this.close();
  }

  /* ---------------- 专辑 / 艺术家 ---------------- */

  groupRows(groups, kind, activeKey){
    if (!groups.length){
      if (this.query){
        return '<div class="lib-empty"><b>没有匹配的' + (kind === 'album' ? '专辑' : '艺术家') + '</b>' +
          '换个关键词试试。</div>';
      }
      return '<div class="lib-empty"><b>还没有' + (kind === 'album' ? '专辑' : '艺术家') + '</b>' +
        '曲目信息里没有' + (kind === 'album' ? '专辑名' : '艺术家') + '，补全标签后刷新即可分组。</div>';
    }
    return groups.map((g) => {
      const key = kind === 'album' ? (g.name || '未知专辑') : (g.name || '未知艺术家');
      const on = activeKey === key ? ' is-cur' : '';
      const initial = (key || '?').trim().slice(0, 1).toUpperCase();
      return '<div class="grp' + on + '" data-key="' + esc(key) + '">' +
        '<span class="grp-ico">' + esc(initial) + '</span>' +
        '<span class="tr-body">' +
          '<span class="tr-t">' + esc(key) + '</span>' +
          '<span class="tr-a">' + g.tracks.length + ' 首 · ' + fmtBytes(g.size) + ' · ' + fmtDuration(g.duration) + '</span>' +
        '</span>' +
        '<span class="grp-arrow">' + (on ? '▾' : '▸') + '</span>' +
      '</div>' +
      (on ? '<div class="grp-body">' + this.trackRows(g.tracks, false) + '</div>' : '');
    }).join('');
  }

  renderAlbums(){
    const groups = groupBy(this.filtered(), t => t.album || '未知专辑')
      .sort((a, b) => (a.name === '未知专辑') - (b.name === '未知专辑') || b.tracks.length - a.tracks.length);
    const key = this.drill && this.drill.kind === 'album' ? this.drill.key : '';
    this.lists.albums.innerHTML = this.groupRows(groups, 'album', key);
  }

  renderArtists(){
    const groups = groupBy(this.filtered(), t => t.artist || '未知艺术家')
      .sort((a, b) => b.tracks.length - a.tracks.length);
    const key = this.drill && this.drill.kind === 'artist' ? this.drill.key : '';
    this.lists.artists.innerHTML = this.groupRows(groups, 'artist', key);
  }

  onGroupClick(e, kind){
    const row = e.target.closest('.grp');
    if (row){
      const key = row.dataset.key;
      const same = this.drill && this.drill.kind === kind && this.drill.key === key;
      this.drill = same ? null : { kind, key, name: key };
      this.redraw();
      return;
    }
    // 展开后的曲目行
    const tr = e.target.closest('.tr');
    if (tr){
      const idx = +tr.dataset.i;
      if (idx >= 0) this.hooks.onPlay(idx);
      return;
    }
  }

  /* ---------------- 歌单 ---------------- */

  renderPlaylists(){
    if (!this.playlists.length){
      this.lists.playlists.innerHTML =
        '<div class="lib-empty"><b>还没有歌单</b>点上面「新建歌单」，然后在歌曲上长按或右键加入。</div>';
      return;
    }
    const active = this.drill && this.drill.kind === 'playlist' ? this.drill.key : '';
    const html = this.playlists.map((p) => {
      const on = active === p.id;
      const isFav = p.id === 'pl:fav';   // 「收藏」是固定歌单，图标用心形、不给删
      const secs = p.ids.reduce((s, id) => {
        const t = this.tracks.find(x => x.id === id);
        return s + (t ? (t.duration || 0) : 0);
      }, 0);
      const body = on
        ? '<div class="grp-body">' + this.playlistTracks(p) + '</div>'
        : '';
      return '<div class="grp' + (on ? ' is-cur' : '') + '" data-pl="' + p.id + '">' +
        '<span class="grp-ico' + (isFav ? ' is-fav' : '') + '">' + (isFav ? '♥' : '♪') + '</span>' +
        '<span class="tr-body">' +
          '<span class="tr-t">' + esc(p.name) + '</span>' +
          '<span class="tr-a">' + p.ids.length + ' 首 · ' + fmtDuration(secs) + '</span>' +
        '</span>' +
        '<span class="grp-arrow">' + (on ? '▾' : '▸') + '</span>' +
      '</div>' + body;
    }).join('');

    const cur = this.drill && this.drill.kind === 'playlist'
      ? this.playlists.find(p => p.id === this.drill.key) : null;
    const actions = cur && cur.id !== 'pl:fav'
      ? '<div class="pl-actions">' +
          '<button class="tool danger" data-act="delete">删除这个歌单</button>' +
        '</div>'
      : '';
    this.lists.playlists.innerHTML = html + actions;
  }

  playlistTracks(p){
    const list = p.ids.map(id => this.tracks.find(t => t.id === id)).filter(Boolean);
    if (!list.length) return '<div class="lib-empty small">这个歌单还是空的</div>';
    return list.map((t) => {
      const i = this.tracks.indexOf(t);
      return '<div class="tr" data-i="' + i + '" data-pl-rm="' + esc(t.id) + '">' +
        '<span class="tr-n">·</span>' +
        '<span class="tr-body">' +
          '<span class="tr-t">' + esc(t.title || '未知曲目') + '</span>' +
          '<span class="tr-a">' + esc(t.artist || '') + '</span>' +
        '</span>' +
        '<span class="tr-d">移除</span>' +
      '</div>';
    }).join('');
  }

  onPlaylistClick(e){
    const act = e.target.closest('[data-act]');
    if (act){
      this.hooks.onPlaylistAction(act.dataset.act, this.drill && this.drill.key);
      return;
    }
    const rm = e.target.closest('[data-pl-rm]');
    if (rm){
      e.stopPropagation();
      this.hooks.onRemoveFromPlaylist(this.drill.key, rm.dataset.plRm);
      return;
    }
    const grp = e.target.closest('.grp');
    if (grp){
      const id = grp.dataset.pl;
      const same = this.drill && this.drill.kind === 'playlist' && this.drill.key === id;
      const p = this.playlists.find(x => x.id === id);
      this.drill = same ? null : { kind: 'playlist', key: id, name: p ? p.name : '' };
      this.redraw();
      return;
    }
    const tr = e.target.closest('.tr');
    if (tr){
      const idx = +tr.dataset.i;
      if (idx >= 0) this.hooks.onPlay(idx);
    }
  }

  /* ---------------- 设置 ---------------- */

  renderSettings(){
    const s = summary();
    const lib = libraryStats(this.tracks);
    const info = this.libraryInfo || {};
    const platform = info.platform || 'web';

    const levelRows = LEVELS.map((l) => {
      const b = lib.byLevel[l.key];
      const pct = lib.count ? Math.round(b.count / lib.count * 100) : 0;
      return '<div class="lvl-row">' +
        '<span class="lvl-dot" style="background:' + l.color + '"></span>' +
        '<span class="lvl-name">' + l.name + '<em>' + l.desc + '</em></span>' +
        '<span class="lvl-bar"><i style="width:' + pct + '%;background:' + l.color + '"></i></span>' +
        '<span class="lvl-val">' + b.count + ' 首<em>' + fmtBytes(b.size) + '</em></span>' +
      '</div>';
    }).join('');

    const fmtRows = lib.formats.length
      ? lib.formats.map(f =>
          '<div class="kv-row"><span>' + esc(f.format) + '</span>' +
          '<b>' + f.count + ' 首 · ' + fmtBytes(f.size) + '</b></div>').join('')
      : '<div class="kv-row"><span>暂无</span><b>—</b></div>';

    const dirRow = info.folder
      ? '<div class="kv-row col"><span>曲库目录</span><b class="path" title="' + esc(info.folder) + '">' + esc(info.folder) + '</b></div>'
      : '';

    const platformName = platform === 'android' ? 'Android' : platform === 'desktop' ? 'Windows 桌面版' : '网页版';

    const notifGroup = platform === 'android'
      ? '<div class="set-group">' +
          '<h3>通知栏</h3>' +
          '<div class="kv-row"><span>媒体卡片</span><b>' +
            (info.notifOk === false ? '未授权' : '已开启') + '</b></div>' +
          '<p class="set-note">' +
            (info.notifOk === false
              ? '通知权限被关掉了，播放时通知栏和锁屏不会出现控制卡片。'
              : '播放时通知栏 / 锁屏会显示「上一首 · 播放暂停 · 下一首」。') +
          '</p>' +
          '<div class="set-actions">' +
            '<button class="tool" data-set="notif">打开通知设置</button>' +
          '</div>' +
        '</div>'
      : '';

    const sw = (key, on, title, desc) =>
      '<button class="set-switch" data-set="' + key + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="sw-txt"><b>' + title + '</b><em>' + desc + '</em></span>' +
        '<span class="sw-track"><i></i></span>' +
      '</button>';

    const screenGroup = platform === 'android'
      ? '<div class="set-group">' +
          '<h3>屏幕</h3>' +
          sw('keep-on', this.keepOn, '保持屏幕常亮', '放唱片的时候不让屏幕自动熄灭') +
          sw('hide-bar', this.hideBar, '隐藏顶部状态栏', '时间、电量那一行收起，封面更满') +
          '<p class="set-note">隐藏状态栏后，从屏幕顶部下滑可以临时叫回来。</p>' +
        '</div>'
      : '';

    this.lists.settings.innerHTML =
      '<div class="set-group">' +
        '<h3>音乐库</h3>' +
        '<div class="stat-cards">' +
          '<div class="stat-card"><b>' + lib.count + '</b><span>曲目</span></div>' +
          '<div class="stat-card"><b>' + fmtBytes(lib.size) + '</b><span>总大小</span></div>' +
          '<div class="stat-card"><b>' + fmtDuration(lib.duration) + '</b><span>总时长</span></div>' +
        '</div>' +
        '<div class="lvl-list">' + levelRows + '</div>' +
        '<div class="kv-row col"><span>按格式</span></div>' +
        '<div class="kv-list">' + fmtRows + '</div>' +
        dirRow +
      '</div>' +

      '<div class="set-group">' +
        '<h3>听歌数据</h3>' +
        '<div class="stat-cards">' +
          '<div class="stat-card"><b>' + s.plays + '</b><span>累计播放</span></div>' +
          '<div class="stat-card"><b>' + fmtDuration(s.seconds) + '</b><span>累计收听</span></div>' +
          '<div class="stat-card"><b>' + s.tracks + '</b><span>听过的歌</span></div>' +
        '</div>' +
        '<div class="kv-list">' +
          '<div class="kv-row"><span>今天</span><b>' + s.today.plays + ' 次 · ' + fmtDuration(s.today.seconds) + '</b></div>' +
          '<div class="kv-row"><span>最近 7 天</span><b>' + s.week.plays + ' 次 · ' + fmtDuration(s.week.seconds) + '</b></div>' +
        '</div>' +
        '<div class="set-actions">' +
          '<button class="tool" data-set="reset-stats">清空听歌统计</button>' +
        '</div>' +
      '</div>' +

      '<div class="set-group">' +
        '<h3>播放</h3>' +
        '<div class="kv-row"><span>默认视图</span><b>' + (this.view === 'visual' ? '频谱' : '歌词') + '</b></div>' +
        '<div class="kv-row"><span>音量</span><b>' + Math.round((this.volume == null ? .72 : this.volume) * 100) + '%</b></div>' +
        '<div class="set-actions">' +
          '<button class="tool" data-set="view">切换默认视图</button>' +
        '</div>' +
      '</div>' +

      notifGroup +

      screenGroup +

      '<div class="set-group">' +
        '<h3>关于</h3>' +
        '<div class="kv-list">' +
          '<div class="kv-row"><span>运行环境</span><b>' + platformName + '</b></div>' +
          '<div class="kv-row"><span>版本</span><b>2.0.0</b></div>' +
          '<div class="kv-row"><span>网络</span><b>不联网</b></div>' +
        '</div>' +
        '<p class="set-note">曲库与统计都存在本机，不上传任何数据。</p>' +
      '</div>';
  }

  onSettingsClick(e){
    const b = e.target.closest('[data-set]');
    if (!b) return;
    this.hooks.onSetting(b.dataset.set);
  }

  /* 只更新播放态，避免整表重绘 */
  updatePlaying(index, playing){
    this.index = index;
    this.playing = !!playing;
    const rows = this.list.children;
    for (let i = 0; i < rows.length; i++){
      const r = rows[i];
      if (!r.classList) continue;
      const idx = +r.dataset.i;
      if (!(idx >= 0)) continue;
      r.classList.toggle('is-cur', idx === index);
      r.classList.toggle('is-on', idx === index && playing);
      const n = r.querySelector('.tr-n');
      if (n) n.textContent = idx === index ? '▶' : String(idx + 1).padStart(2, '0');
    }
  }
}
