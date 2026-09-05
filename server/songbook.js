'use strict';

const fs = require('fs');
const { parseCsv } = require('./csv');

const MAX_RESULTS = 100;

/** Lowercase, strip accents and punctuation, then collapse whitespace. */
function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Keep only a-z / 0-9 — used for the loose "some of the letters" pass. */
function letters(str) {
  return normalize(str).replace(/[^a-z0-9]/g, '');
}

/**
 * 36-bit mask (a-z + 0-9) of which characters a string contains.
 * Lets the fuzzy pass reject most songs with a single integer test.
 */
function charMask(compact) {
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < compact.length; i++) {
    const c = compact.charCodeAt(i);
    if (c >= 97 && c <= 122) lo |= 1 << (c - 97);
    else if (c >= 48 && c <= 57) hi |= 1 << (c - 48);
  }
  return { lo, hi };
}

/** True when every char of `needle` appears in `haystack` in order. */
function isSubsequence(needle, haystack) {
  let n = 0;
  for (let h = 0; h < haystack.length && n < needle.length; h++) {
    if (haystack[h] === needle[n]) n++;
  }
  return n === needle.length;
}

class Songbook {
  constructor() {
    this.songs = [];
    this.artists = [];
    this.loadedAt = null;
    this.sourceFile = null;
  }

  /**
   * Parse a CSV of artist/title pairs and build the in-memory index.
   * Column order is auto-detected from the header when present.
   */
  loadFromFile(filePath) {
    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    if (rows.length === 0) throw new Error(`CSV "${filePath}" is empty`);

    let artistCol = 0;
    let titleCol = 1;
    let start = 0;

    const header = rows[0].map((c) => normalize(c));
    const headerArtist = header.findIndex((c) => /artist|band|performer|singer/.test(c));
    const headerTitle = header.findIndex((c) => /title|song|track|name/.test(c));
    if (headerArtist !== -1 && headerTitle !== -1 && headerArtist !== headerTitle) {
      artistCol = headerArtist;
      titleCol = headerTitle;
      start = 1;
    }

    const songs = [];
    const artistMap = new Map();

    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const artist = (row[artistCol] || '').trim();
      const title = (row[titleCol] || '').trim();
      if (!artist && !title) continue;

      const artistKey = normalize(artist);
      let artistEntry = artistMap.get(artistKey);
      if (!artistEntry) {
        artistEntry = { name: artist || 'Unknown', key: artistKey, songs: [] };
        artistMap.set(artistKey, artistEntry);
      }

      const normArtist = artistKey;
      const normTitle = normalize(title);
      const compact = letters(artist + title);

      const song = {
        id: songs.length,
        artist: artistEntry.name,
        title,
        artistKey,
        _a: normArtist,
        _t: normTitle,
        _c: compact,
        _mask: charMask(compact)
      };

      songs.push(song);
      artistEntry.songs.push(song.id);
    }

    const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
    const artists = [...artistMap.values()]
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((a) => {
        a.songs.sort((x, y) => collator.compare(songs[x].title, songs[y].title));
        return a;
      });

    this.songs = songs;
    this.artists = artists;
    this.artistIndex = artistMap;
    this.collator = collator;
    this.loadedAt = new Date();
    this.sourceFile = filePath;

    return { songs: songs.length, artists: artists.length };
  }

  artistList() {
    return this.artists.map((a) => ({ key: a.key, name: a.name, count: a.songs.length }));
  }

  songsForArtist(key) {
    const artist = this.artistIndex.get(normalize(key));
    if (!artist) return null;
    return {
      artist: artist.name,
      songs: artist.songs.map((id) => this.toPublic(this.songs[id]))
    };
  }

  toPublic(song) {
    return { id: song.id, artist: song.artist, title: song.title, artistKey: song.artistKey };
  }

  /**
   * Two-pass search:
   *  1. phrase match — artist or title contains the typed phrase
   *  2. loose match — the typed letters appear, in order, anywhere in "artist title"
   * Capped at `limit` (default 100) results.
   */
  search(query, limit = MAX_RESULTS) {
    const phrase = normalize(query);
    if (!phrase) return [];

    const cap = Math.max(1, Math.min(limit, MAX_RESULTS));
    const exact = [];
    const seen = new Uint8Array(this.songs.length);

    for (let i = 0; i < this.songs.length; i++) {
      const s = this.songs[i];
      const ti = s._t.indexOf(phrase);
      const ai = s._a.indexOf(phrase);
      if (ti === -1 && ai === -1) continue;

      // lower rank = better: title-prefix, artist-prefix, then containment
      let rank;
      if (ti === 0) rank = 0;
      else if (ai === 0) rank = 1;
      else if (ti > 0) rank = 2;
      else rank = 3;

      exact.push({ song: s, rank, pos: ti === -1 ? ai : ti });
      seen[i] = 1;
    }

    exact.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.pos - b.pos ||
        this.collator.compare(a.song.artist, b.song.artist) ||
        this.collator.compare(a.song.title, b.song.title)
    );

    const results = exact.slice(0, cap).map((e) => ({ ...this.toPublic(e.song), match: 'phrase' }));
    if (results.length >= cap) return results;

    const needle = letters(query);
    if (!needle) return results;

    const { lo, hi } = charMask(needle);
    const fuzzy = [];

    for (let i = 0; i < this.songs.length; i++) {
      if (seen[i]) continue;
      const s = this.songs[i];
      if ((s._mask.lo & lo) !== lo || (s._mask.hi & hi) !== hi) continue;
      if (!isSubsequence(needle, s._c)) continue;
      fuzzy.push({ song: s, spread: s._c.length });
    }

    fuzzy.sort(
      (a, b) =>
        a.spread - b.spread ||
        this.collator.compare(a.song.artist, b.song.artist) ||
        this.collator.compare(a.song.title, b.song.title)
    );

    for (const f of fuzzy) {
      if (results.length >= cap) break;
      results.push({ ...this.toPublic(f.song), match: 'loose' });
    }

    return results;
  }

  randomSong() {
    if (this.songs.length === 0) return null;
    const i = Math.floor(Math.random() * this.songs.length);
    return this.toPublic(this.songs[i]);
  }
}

module.exports = { Songbook, MAX_RESULTS };
