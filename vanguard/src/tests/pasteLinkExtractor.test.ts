/**
 * Paste Link Extractor Tests — Vanguard Detection Layer
 *
 * Pure-logic tests for paste-service identification and raw-content
 * URL construction (mclogs API, pastebin raw, bytebin).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { identifyPasteService, getRawContentUrl } from '../detection/pasteLinkExtractor.js';

describe('identifyPasteService', () => {
  it('should identify mclo.gs and mclogs.io as mclogs', () => {
    assert.equal(identifyPasteService('https://mclo.gs/AbC123'), 'mclogs');
    assert.equal(identifyPasteService('https://mclogs.io/log/AbC123'), 'mclogs');
  });

  it('should identify pastebin.com as pastebin', () => {
    assert.equal(identifyPasteService('https://pastebin.com/raw/xyz'), 'pastebin');
  });

  it('should identify gnome.dev as gnome', () => {
    assert.equal(identifyPasteService('https://gnome.dev/paste/abc'), 'gnome');
  });

  it('should identify bytebin.lucko.me as bytebin', () => {
    assert.equal(identifyPasteService('https://bytebin.lucko.me/abc'), 'bytebin');
  });

  it('should return null for unsupported services', () => {
    assert.equal(identifyPasteService('https://example.com/log'), null);
    assert.equal(identifyPasteService('not a url'), null);
  });
});

describe('getRawContentUrl', () => {
  it('should map mclo.gs URLs to the mclogs API endpoint', () => {
    const raw = getRawContentUrl('https://mclo.gs/AbC123', 'mclogs');
    assert.equal(raw, 'https://api.mclo.gs/1/log/AbC123');
  });

  it('should map mclogs.io URLs to the mclogs API endpoint', () => {
    const raw = getRawContentUrl('https://mclogs.io/AbC123', 'mclogs');
    assert.equal(raw, 'https://api.mclo.gs/1/log/AbC123');
  });

  it('should map pastebin URLs to their /raw/ variant', () => {
    const raw = getRawContentUrl('https://pastebin.com/AbC123', 'pastebin');
    assert.equal(raw, 'https://pastebin.com/raw/AbC123');
  });

  it('should map bytebin URLs to their raw variant', () => {
    const raw = getRawContentUrl('https://bytebin.lucko.me/AbC123', 'bytebin');
    assert.equal(raw, 'https://bytebin.lucko.me/AbC123');
  });

  it('should pass through URLs for services without a raw transform', () => {
    const url = 'https://gnome.dev/paste/abc';
    assert.equal(getRawContentUrl(url, 'gnome'), url);
  });

  it('should pass through unparseable URLs unchanged', () => {
    const url = 'https://mclo.gs/';
    assert.equal(getRawContentUrl(url, 'mclogs'), url);
  });
});
