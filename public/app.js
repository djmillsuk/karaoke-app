'use strict';

const MAX_RESULTS = 100;
const ARTIST_ROW = 44;
const SONG_ROW = 56;

const el = {
  search: document.getElementById('search'),
  random: document.getElementById('random'),
  favourites: document.getElementById('favourites'),
  favCount: document.getElementById('fav-count'),
  stats: document.getElementById('stats'),
  artistCount: document.getElementById('artist-count'),
  artistScroll: document.getElementById('artist-scroll'),
  artistSpacer: document.getElementById('artist-spacer'),
  artistList: document.getElementById('artist-list'),
  detailHeading: document.getElementById('detail-heading'),
  detailSub: document.getElementById('detail-sub'),
  detailScroll: document.getElementById('detail-scroll'),
  detailSpacer: document.getElementById('detail-spacer'),
  songList: document.getElementById('song-list'),
  toast: document.getElementById('toast')
};

/**
 * Windowed list renderer: only the rows in view (plus a small overscan)
 * exist in the DOM, so 10k+ entries scroll without lag.
 */
class VirtualList {
  constructor(scroller, spacer, list, rowHeight, renderRow) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.list = list;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.items = [];
    this.range = [-1, -1];
    this.frame = null;

    const onScroll = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.draw();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
  }

  setItems(items, { keepScroll = false, emptyText = '' } = {}) {
    this.items = items;
    this.emptyText = emptyText;
    if (!keepScroll) this.scroller.scrollTop = 0;
    this.spacer.style.height = items.length * this.rowHeight + 'px';
    this.range = [-1, -1];
    this.draw();
  }

  draw() {
    const total = this.items.length;
    if (total === 0) {
      if (this.emptyText) {
        const p = document.createElement('li');
        p.className = 'empty';
        p.textContent = this.emptyText;
        this.list.replaceChildren(p);
      } else {
        this.list.replaceChildren();
      }
      this.range = [-1, -1];
      return;
    }
    const overscan = 6;
    const height = this.scroller.clientHeight || 600;
    const first = Math.max(0, Math.floor(this.scroller.scrollTop / this.rowHeight) - overscan);
    const last = Math.min(total, Math.ceil((this.scroller.scrollTop + height) / this.rowHeight) + overscan);
    if (first === this.range[0] && last === this.range[1]) return;
    this.range = [first, last];

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const node = this.renderRow(this.items[i], i);
      node.style.top = i * this.rowHeight + 'px';
      node.style.height = this.rowHeight + 'px';
      node.dataset.index = String(i);
      frag.appendChild(node);
    }
    this.list.replaceChildren(frag);
  }

  refresh() {
    this.range = [-1, -1];
    this.draw();
  }

  scrollToIndex(index) {
    const target = index * this.rowHeight - this.scroller.clientHeight / 2 + this.rowHeight / 2;
    this.scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    this.draw();
  }
}

const state = {
  artists: [],
  selectedArtist: null,
  songs: [],
  mode: 'artist', // 'artist' | 'search' | 'favourites'
  query: ''
};

const FAV_KEY = 'karaoke.favourites.v1';

/** Identity that survives CSV reloads/re-ordering, unlike the numeric song id. */
function favKey(song) {
  return `${song.artist}\u0000${song.title}`.toLowerCase();
}

const favourites = new Map();

function loadFavourites() {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (item && typeof item.artist === 'string' && typeof item.title === 'string') {
        favourites.set(favKey(item), { artist: item.artist, title: item.title, artistKey: item.artistKey });
      }
    }
  } catch {
    localStorage.removeItem(FAV_KEY);
  }
}

function saveFavourites() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify([...favourites.values()]));
  } catch (err) {
    toast('Could not save favourites (storage full or blocked)');
  }
  el.favCount.textContent = favourites.size;
}

function favouriteList() {
  return [...favourites.values()].sort(
    (a, b) => a.artist.localeCompare(b.artist, 'en', { sensitivity: 'base' }) ||
      a.title.localeCompare(b.title, 'en', { sensitivity: 'base' })
  );
}

/** Build highlighted text nodes without ever injecting raw HTML. */
function highlighted(text, phrase) {
  const span = document.createElement('span');
  if (!phrase) {
    span.textContent = text;
    return span;
  }
  const hay = text.toLowerCase();
  const needle = phrase.toLowerCase();
  let from = 0;
  let idx = hay.indexOf(needle, from);
  if (idx === -1) {
    span.textContent = text;
    return span;
  }
  while (idx !== -1) {
    if (idx > from) span.appendChild(document.createTextNode(text.slice(from, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + needle.length);
    span.appendChild(mark);
    from = idx + needle.length;
    idx = hay.indexOf(needle, from);
  }
  if (from < text.length) span.appendChild(document.createTextNode(text.slice(from)));
  return span;
}

const artistView = new VirtualList(
  el.artistScroll,
  el.artistSpacer,
  el.artistList,
  ARTIST_ROW,
  (artist) => {
    const li = document.createElement('li');
    li.className = 'row artist-row' + (state.selectedArtist === artist.key ? ' selected' : '');
    li.dataset.key = artist.key;
    li.tabIndex = 0;

    const name = document.createElement('span');
    name.className = 'name';
    name.appendChild(highlighted(artist.name, state.query));
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = artist.count;

    li.append(name, count);
    return li;
  }
);

const songView = new VirtualList(
  el.detailScroll,
  el.detailSpacer,
  el.songList,
  SONG_ROW,
  (song) => {
    const li = document.createElement('li');
    li.className = 'row song' + (song.match === 'loose' ? ' loose' : '');
    li.dataset.id = String(song.id);
    li.dataset.artistKey = song.artistKey;

    const wrap = document.createElement('span');
    wrap.className = 'name';

    const title = document.createElement('span');
    title.className = 'title';
    title.appendChild(highlighted(song.title, state.query));

    const artist = document.createElement('span');
    artist.className = 'artist';
    artist.appendChild(highlighted(song.artist, state.query));

    const star = document.createElement('button');
    const isFav = favourites.has(favKey(song));
    star.type = 'button';
    star.className = 'fav' + (isFav ? ' on' : '');
    star.textContent = isFav ? '★' : '☆';
    star.setAttribute('aria-pressed', String(isFav));
    star.title = isFav ? 'Remove from favourites' : 'Add to favourites';
    star.setAttribute('aria-label', `${isFav ? 'Remove' : 'Add'} ${song.title} by ${song.artist}`);

    wrap.append(title, artist);
    li.append(wrap, star);
    return li;
  }
);

function setDetail(heading, sub, songs, opts = {}) {
  el.detailHeading.textContent = heading;
  el.detailSub.textContent = sub;
  state.songs = songs;
  songView.setItems(songs, opts);
}

function setArtists(list, emptyText) {
  artistView.setItems(list, { emptyText });
  el.artistCount.textContent = list.length.toLocaleString();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function loadArtists() {
  state.artists = await getJson('/api/artists');
  setArtists(state.artists);
  const stats = await getJson('/api/stats');
  el.stats.textContent = `${stats.songs.toLocaleString()} songs · ${stats.artists.toLocaleString()} artists · showing up to ${MAX_RESULTS} search results`;
}

async function showArtist(key) {
  state.selectedArtist = key;
  state.mode = 'artist';
  el.favourites.setAttribute('aria-pressed', 'false');
  artistView.refresh();
  const data = await getJson(`/api/artists/${encodeURIComponent(key)}/songs`);
  setDetail(data.artist, `${data.songs.length} song${data.songs.length === 1 ? '' : 's'}`, data.songs);
}

function showFavourites() {
  state.mode = 'favourites';
  state.query = '';
  el.search.value = '';
  el.favourites.setAttribute('aria-pressed', 'true');
  setArtists(state.artists);
  const list = favouriteList();
  setDetail(
    'Favourites',
    list.length === 0
      ? 'Tap the ☆ next to any song to save it here. Stored on this device only.'
      : `${list.length} saved song${list.length === 1 ? '' : 's'} · tap ★ to remove`,
    list,
    { emptyText: 'No favourites yet.' }
  );
}

let searchToken = 0;
async function runSearch(query) {
  const token = ++searchToken;
  state.query = query;

  if (!query.trim()) {
    state.mode = 'artist';
    el.favourites.setAttribute('aria-pressed', 'false');
    setArtists(state.artists);
    if (state.selectedArtist) {
      showArtist(state.selectedArtist);
    } else {
      setDetail('Pick an artist', 'Or type in the search box above.', []);
    }
    return;
  }

  state.mode = 'search';
  el.favourites.setAttribute('aria-pressed', 'false');
  const data = await getJson(`/api/search?q=${encodeURIComponent(query)}`);
  if (token !== searchToken) return; // a newer keystroke already won

  const q = query.trim().toLowerCase();
  const filteredArtists = state.artists.filter((a) => a.name.toLowerCase().includes(q));
  setArtists(filteredArtists, 'No artist names contain that phrase.');

  const capped = data.count >= data.limit ? ` (first ${data.limit})` : '';
  setDetail(
    `Results for “${query.trim()}”`,
    data.count === 0 ? 'No matches — try fewer letters.' : `${data.count} match${data.count === 1 ? '' : 'es'}${capped} · ≈ marks loose letter matches`,
    data.results
  );
}

let debounce;
el.search.addEventListener('input', () => {
  clearTimeout(debounce);
  const value = el.search.value;
  debounce = setTimeout(() => runSearch(value), 120);
});

el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    el.search.value = '';
    runSearch('');
  }
});

el.artistScroll.addEventListener('click', (e) => {
  const row = e.target.closest('.artist-row');
  if (row) showArtist(row.dataset.key);
});

el.artistScroll.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.artist-row');
  if (row) {
    e.preventDefault();
    showArtist(row.dataset.key);
  }
});

el.detailScroll.addEventListener('click', (e) => {
  const star = e.target.closest('.fav');
  if (!star) return;
  const index = Number(star.parentElement.dataset.index);
  const song = state.songs[index];
  if (!song) return;

  const key = favKey(song);
  if (favourites.has(key)) {
    favourites.delete(key);
    toast(`Removed “${song.title}” from favourites`);
  } else {
    favourites.set(key, { artist: song.artist, title: song.title, artistKey: song.artistKey });
    toast(`★ Saved “${song.title}” — ${song.artist}`);
  }
  saveFavourites();

  if (state.mode === 'favourites') showFavourites();
  else songView.refresh();
});

el.favourites.addEventListener('click', () => {
  if (state.mode === 'favourites') {
    el.favourites.setAttribute('aria-pressed', 'false');
    runSearch(el.search.value);
  } else {
    showFavourites();
  }
});

// Keep tabs on the same device in sync.
window.addEventListener('storage', (e) => {
  if (e.key !== FAV_KEY) return;
  favourites.clear();
  loadFavourites();
  el.favCount.textContent = favourites.size;
  if (state.mode === 'favourites') showFavourites();
  else songView.refresh();
});

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4000);
}

function flashSong(index) {
  songView.scrollToIndex(index);
  requestAnimationFrame(() => {
    const node = el.songList.querySelector(`[data-index="${index}"]`);
    if (node) {
      node.classList.remove('flash');
      void node.offsetWidth;
      node.classList.add('flash');
    }
  });
}

el.random.addEventListener('click', async () => {
  const song = await getJson('/api/random');
  state.mode = 'random';
  el.favourites.setAttribute('aria-pressed', 'false');
  setDetail('Random pick', 'Straight from the whole songbook.', [song]);
  flashSong(0);
  toast(`🎲 ${song.title} — ${song.artist}`);
});

loadFavourites();
el.favCount.textContent = favourites.size;

loadArtists().catch((err) => {
  el.stats.textContent = `Could not load songbook: ${err.message}`;
});
