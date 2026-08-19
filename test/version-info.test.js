'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appMain = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-main.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('버전 정보에 bytenode 3과 byteexam 3s가 노출된다', () => {
  assert.match(appMain, /codeName:'bytenode 3'/);
  assert.match(appMain, /codeName:'byteexam 3s'/);
  assert.match(appMain, /key:'3s', label:'3s'/);
  assert.match(appMain, /key:'3',\s+label:'3'/);
});

test('bytenode 3 프롬프트가 출처 각주를 안내하고 기존 렌더러가 지원한다', () => {
  assert.match(appMain, /【출처 각주 — bytenode 3】/);
  assert.match(appMain, /<footnote: 출처:/);
  assert.match(appMain, /case 'footnote'/);
});

test('도우미의 현재 제품 정보가 3세대로 갱신된다', () => {
  assert.match(server, /# bytenode 플랫폼 \(현재 버전: 3\)/);
  assert.match(server, /# byteexam 플랫폼 \(현재 버전: 3s\)/);
  assert.match(server, /사회\(중1~고3\), 정보·파이썬\(고1~고3\)/);
});
