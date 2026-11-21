import test from 'node:test';
import assert from 'node:assert/strict';

import {
  htmlToText,
  decodeEntities,
  sanitizeName,
  fmtDate,
  humanSize,
  allFiles,
  renderStructure,
} from '../lib/course.mjs';
import { extractLoginToken } from '../lib/auth.mjs';
import { HttpClient, redact, redactUrl, scrub, stripUrlSecrets } from '../lib/http.mjs';

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &laquo;c&raquo;'), 'a & b «c»');
  assert.equal(decodeEntities('caf&#233; &#xE9;'), 'café é');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('htmlToText strips markup and keeps list structure', () => {
  const html = '<p>Hello <b>world</b></p><ul><li>one</li><li>two</li></ul><br>';
  const text = htmlToText(html);
  assert.match(text, /Hello world/);
  assert.match(text, /• one/);
  assert.match(text, /• two/);
  assert.ok(!text.includes('<'), 'no tags left');
});

test('htmlToText drops scripts and collapses blank lines', () => {
  const text = htmlToText('<script>evil()</script><style>a{}</style><p>x</p>\n\n\n<p>y</p>');
  assert.equal(text, 'x\n\ny');
});

test('htmlToText survives empty input', () => {
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(undefined), '');
});

test('sanitizeName removes path-hostile characters', () => {
  assert.equal(sanitizeName('a/b:c*?"<>|d'), 'a_b_c______d');
  assert.equal(sanitizeName('  spaced   name  '), 'spaced name');
  assert.ok(sanitizeName('x'.repeat(300)).length <= 120);
  assert.ok(!sanitizeName('...hidden').startsWith('.'));
});

test('fmtDate formats unix seconds in the configured zone and tolerates empty values', () => {
  assert.equal(fmtDate(0), '—');
  assert.equal(fmtDate(null), '—');
  assert.equal(fmtDate(undefined), '—');
  assert.match(fmtDate(1700000000), /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/);
});

test('humanSize switches units', () => {
  assert.equal(humanSize(512), '512 B');
  assert.equal(humanSize(2048), '2.0 KB');
  assert.equal(humanSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(humanSize(undefined), '0 B');
});

const SECTIONS = [
  {
    section: 1,
    name: 'Intro',
    modules: [
      {
        id: 11,
        name: 'Lecture',
        modname: 'resource',
        contents: [
          { type: 'file', filename: 'lecture.pdf', fileurl: 'https://x/1.pdf', filesize: 2048 },
          { type: 'url', filename: 'video', fileurl: 'https://youtu.be/x' },
        ],
      },
      {
        id: 22,
        name: 'Lab',
        modname: 'assign',
        contents: [],
      },
    ],
  },
];

test('allFiles keeps only downloadable files', () => {
  const files = allFiles(SECTIONS);
  assert.equal(files.length, 1);
  assert.equal(files[0].filename, 'lecture.pdf');
  assert.equal(files[0].section, 'Intro');
});

test('renderStructure lists sections, modules and due dates', () => {
  const md = renderStructure(
    { id: 5, fullname: 'Example Course', shortname: 'EX101' },
    SECTIONS,
    [{ cmid: 22, duedate: 1700000000 }],
  );
  assert.match(md, /^# Example Course/m);
  assert.match(md, /## 1\. Intro/);
  assert.match(md, /resource/);
  assert.match(md, /lecture\.pdf/);
  assert.match(md, /due: \d{2}\.\d{2}\.\d{4}/);
});

test('extractLoginToken reads the hidden input of the login form', () => {
  const html = `<form action="/login/index.php" method="post" id="login">
    <input type="hidden" name="logintoken" value="abc123">
    <input name="username">
  </form>`;
  assert.equal(extractLoginToken(html), 'abc123');
});

test('extractLoginToken returns null when the form is missing', () => {
  assert.equal(extractLoginToken('<form id="login"></form>'), null);
  assert.equal(extractLoginToken(''), null);
});

test('HttpClient requires an explicitly configured site', () => {
  assert.throws(() => new HttpClient({ baseUrl: '' }), /No Moodle site configured/);
});

test('HttpClient normalises a trailing slash', () => {
  const client = new HttpClient({ baseUrl: 'https://moodle.example.edu/' });
  assert.equal(client.baseUrl, 'https://moodle.example.edu');
});

test('redactUrl drops the query string and the userinfo', () => {
  assert.equal(
    redactUrl('https://moodle.example.edu/login/token.php?username=u&password=p'),
    'https://moodle.example.edu/login/token.php?<redacted>',
  );
  assert.equal(redactUrl('https://user:pass@moodle.example.edu/x'), 'https://<redacted>@moodle.example.edu/x');
  assert.equal(redactUrl('not a url'), '<redacted-url>');
});

test('redact strips secrets from URLs and from key=value pairs', () => {
  const line = 'GET https://moodle.example.edu/webservice/pluginfile.php?token=abc123&file=1 -> 200';
  const safe = redact(line);
  assert.ok(!safe.includes('abc123'), 'token must not survive');
  assert.ok(safe.includes('pluginfile.php?<redacted>'), 'path is kept, query is hidden');
  assert.ok(!redact('password=hunter2&user=x').includes('hunter2'));
  assert.ok(!redact('wstoken=deadbeef').includes('deadbeef'));
  assert.ok(!redact('?secret=topsecret').includes('topsecret'));
});

test('redact leaves harmless text alone', () => {
  assert.equal(redact('GET /login/index.php -> 200'), 'GET /login/index.php -> 200');
});

test('stripUrlSecrets removes credential parameters and keeps the rest', () => {
  assert.equal(
    stripUrlSecrets('https://m.example.edu/webservice/pluginfile.php/1/a.pdf?token=abc&forcedownload=1'),
    'https://m.example.edu/webservice/pluginfile.php/1/a.pdf?forcedownload=1',
  );
  assert.equal(
    stripUrlSecrets('https://m.example.edu/a.pdf?forcedownload=1'),
    'https://m.example.edu/a.pdf?forcedownload=1',
  );
  assert.equal(stripUrlSecrets('https://m.example.edu/x?wstoken=abc'), 'https://m.example.edu/x');
  assert.equal(stripUrlSecrets('https://m.example.edu/x?token=a&wstoken=b'), 'https://m.example.edu/x');
});

test('allFiles hands out token-free URLs', () => {
  const files = allFiles([
    {
      section: 1,
      name: 'S',
      modules: [
        {
          id: 1,
          name: 'M',
          modname: 'resource',
          contents: [
            {
              type: 'file',
              filename: 'a.pdf',
              fileurl: 'https://m.example.edu/f/a.pdf?token=secret-token&forcedownload=1',
              filesize: 10,
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(files[0].fileurl.includes('secret-token'), false);
  assert.equal(files[0].fileurl.includes('forcedownload=1'), true);
});

test('scrub walks nested data, copies it and leaves other values alone', () => {
  const input = { a: [{ fileurl: 'https://m.example.edu/f?token=t0k&x=1' }], n: 5, b: 'plain', c: null };
  const out = scrub(input);
  assert.equal(out.a[0].fileurl.includes('t0k'), false);
  assert.equal(out.a[0].fileurl.includes('x=1'), true);
  assert.equal(out.n, 5);
  assert.equal(out.b, 'plain');
  assert.equal(out.c, null);
  assert.notEqual(out, input, 'scrub returns a copy, the caller keeps the original');
});
