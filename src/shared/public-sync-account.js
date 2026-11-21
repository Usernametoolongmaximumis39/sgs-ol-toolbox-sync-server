export function publicUserCode(id) {
  return typeof id === 'string' && /^\d{1,10}$/.test(id) && Number(id) > 0 && Number(id) <= 0xffffffff ? id.padStart(10, '0') : '';
}

export function publicUserName(name) {
  return name.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').trim().slice(0, 100);
}
