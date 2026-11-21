export const STARGAZING_SITE = 'https://gx.95chong.cn/';
export const STARGAZING_REPORT = STARGAZING_SITE + 'api/report';
export const STARGAZING_SYNC_PATH = '/v1/stargazing/report';
export const STARGAZING_REPORT_LIMIT = 1024 * 1024;

export async function readStargazingJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('观星报表为空');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get('content-length')) > STARGAZING_REPORT_LIMIT) throw new Error('观星报表过大');
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(chunks.join('') + decoder.decode());
      bytes += value.byteLength;
      if (bytes > STARGAZING_REPORT_LIMIT) throw new Error('观星报表过大');
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
