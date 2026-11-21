const browsers = [
  [/\b(?:EdgA|EdgiOS|Edg|Edge)\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\bSamsungBrowser\//, '三星浏览器'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\b(?:Chrome|CriOS|HeadlessChrome)\//, 'Chrome'],
  [/\bChromium\//, 'Chromium'],
  [/\bSafari\//, 'Safari'],
];

export function describeSyncDevice(agent = '', hints) {
  const client = hints?.microclient === true ? '微端' : /\bElectron\//.test(agent) ? 'Electron 客户端'
    : browsers.find(([pattern]) => pattern.test(agent))?.[1];
  let system;
  if (hints?.ipad === true || /\biPad\b/.test(agent)) system = 'iPadOS';
  else if (/\b(?:iPhone|iPod)\b/.test(agent)) system = 'iOS';
  else if (/\bAndroid\b/.test(agent)) system = 'Android';
  else if (/Windows NT 10\.0\b/.test(agent)) system = hints?.windows === 11 ? 'Windows 11' : hints?.windows === 10 ? 'Windows 10' : 'Windows';
  else if (/Windows NT 6\.3\b/.test(agent)) system = 'Windows 8.1';
  else if (/Windows NT 6\.2\b/.test(agent)) system = 'Windows 8';
  else if (/Windows NT 6\.1\b/.test(agent)) system = 'Windows 7';
  else if (/\bWindows\b/.test(agent)) system = 'Windows';
  else if (/\bCrOS\b/.test(agent)) system = 'ChromeOS';
  else if (/\bMacintosh\b/.test(agent)) system = 'macOS';
  else if (/\bLinux\b/.test(agent)) system = 'Linux';
  return { client, system };
}
