// Thin wrapper over the Moodle Web Services REST API.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

export class MoodleError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'MoodleError';
    Object.assign(this, extra);
  }
}

function flatten(value, prefix, out) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}[${k}]` : k, out);
    return;
  }
  out.append(prefix, String(value));
}

export class MoodleWS {
  constructor({ token, baseUrl, http }) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.http = http;
    this.functions = null;
  }

  /** Raw call; throws MoodleError on API-level errors. */
  async call(fn, params = {}, { timeout = 90000 } = {}) {
    const body = new URLSearchParams();
    body.set('wstoken', this.token);
    body.set('wsfunction', fn);
    body.set('moodlewsrestformat', 'json');
    flatten(params, '', body);

    const res = await this.http.request('/webservice/rest/server.php', {
      method: 'POST',
      body: body.toString(),
      timeout,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });

    const text = res.body.toString('utf8');
    if (!text.trim().startsWith('{') && !text.trim().startsWith('[')) {
      // Moodle returns an XML exception payload here.
      const code = /<ERRORCODE>([^<]*)<\/ERRORCODE>/.exec(text)?.[1];
      const msg = /<MESSAGE>([^<]*)<\/MESSAGE>/.exec(text)?.[1];
      throw new MoodleError(msg || `Moodle API error (${res.status})`, { errorcode: code });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MoodleError('Cannot parse the Moodle API response');
    }
    if (data && data.errorcode) {
      throw new MoodleError(data.message || data.errorcode, {
        errorcode: data.errorcode,
        exception: data.exception,
      });
    }
    return data;
  }

  /** Calls that may be disabled for the mobile service are skipped, not fatal. */
  async tryCall(fn, params = {}) {
    try {
      return await this.call(fn, params);
    } catch (err) {
      if (err.errorcode && /accessexception|invalidfunction|nofunction/i.test(err.errorcode)) {
        return null;
      }
      throw err;
    }
  }

  async siteInfo() {
    const info = await this.call('core_webservice_get_site_info');
    this.functions = new Set((info.functions || []).map((f) => f.name));
    this.userId = info.userid;
    return info;
  }

  has(fn) {
    return !this.functions || this.functions.has(fn);
  }

  async courses(userid = this.userId) {
    return this.call('core_enrol_get_users_courses', { userid });
  }

  async courseContents(courseid) {
    return this.call('core_course_get_contents', { courseid });
  }

  async courseModule(cmid) {
    const data = await this.call('core_course_get_course_module', { cmid });
    return data?.cm || null;
  }

  async assignments(courseids) {
    const data = await this.tryCall('mod_assign_get_assignments', { courseids });
    return data?.courses || [];
  }

  async submissionStatus(assignid) {
    return this.tryCall('mod_assign_get_submission_status', { assignid });
  }

  async gradeItems(courseid, userid = this.userId) {
    return this.tryCall('gradereport_user_get_grade_items', { courseid, userid });
  }

  /** Download a pluginfile URL (the token is already embedded in it). */
  async download(fileurl, destPath) {
    const url = new URL(fileurl, this.baseUrl);
    if (!url.searchParams.has('token')) url.searchParams.set('token', this.token);
    const res = await this.http.request(url.toString(), { timeout: 180000, maxRedirects: 8 });
    if (res.status !== 200) {
      throw new MoodleError(`Cannot download file (HTTP ${res.status}): ${url.pathname}`);
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, res.body);
    return { path: destPath, bytes: res.body.length };
  }
}
