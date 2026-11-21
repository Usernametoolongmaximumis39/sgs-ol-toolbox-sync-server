const $ = id => document.getElementById(id);
const messages = {
  account_limit: '账号名额已用完',
  admin_required: '请重新登录管理员',
  candidate_unavailable: '新端口暂不可用，旧端口继续服务，正在重试',
  existing_account_unavailable: '该历史账号已绑定或暂不可用，请刷新后选择',
  invalid_account_limit: '名额需为 1–100，且至少等于已绑定账号数',
  invalid_public_account_limit: '最大绑定账号数必须是有效的非负整数',
  invalid_admin_token: '管理员凭据无效',
  invalid_admin_password: '新密码需为 8–128 位，含英文字母和数字，且不能包含控制字符',
  invalid_certificate: '证书、私钥、有效期或域名不匹配',
  invalid_loopback_domain: '请输入有效地址。仅本机模式支持 localhost 或其子域名。',
  invalid_pairing_request: '配对请求格式错误，请重新复制',
  invalid_port: '端口或 HTTPS 跳转设置无效',
  invalid_quota: '次数或有效时长超出范围',
  invitation_unavailable: '该批次的邀请已过期、用完或撤销',
  migration_in_progress: '请先等待当前切换完成，或取消切换',
  new_port_required: '更改域名或 HTTP／HTTPS 时，请填写一个新端口',
  port_in_use: '该端口由管理页使用',
  port_unavailable: '无法监听该端口，请检查是否已占用',
  rate_limited: '尝试次数较多，请稍后再试',
  private_request_expired: '四位码不存在或已过期，请回到工具箱重新生成',
  installation_already_bound: '服务器已有私有绑定，请使用私有配对',
  primary_required: '请先通过四位码绑定主账号',
  child_required: '请选择当前启用的附属账号',
  account_already_bound: '该游戏账号已在列表中',
  invalid_device_name: '设备名称最多 48 个字符，不能包含换行或控制字符',
  recovery_expired: '该账号已超过 30 天恢复期',
  recovery_pending: '请先恢复已移除的账号，或等待恢复期结束',
  history_not_staged: '仍有历史账号未上传最新的加密副本',
  https_required: '请先配置有效的 SSL 证书并启动 HTTPS 端口',
  public_domain_required: '启用外网访问时需要有效的公网域名和对应证书',
  confirmation_required: '请输入「转为公共」确认',
  public_mode_required: '公共服务器使用加密存储',
  server_update_unavailable: '当前安装方式未启用服务端自更新',
  server_update_busy: '正在处理上一项更新请求',
  server_update_version_changed: '可用版本已变化，请重新检查',
  setup_restricted: '首次设置仅可在新实例上配置 HTTPS 和切换公共模式',
  setup_pem_missing: '服务端数据目录缺少证书链或私钥文件，请按安装文档放置后重试',
  setup_expired: '首次设置入口已到期，请通过回环管理地址继续',
};
const number = id => Number($(id).value);
const enabled = id => $(id).getAttribute('aria-checked') === 'true';
const displayTime = value => new Date(value).toLocaleString();
const short = id => id.slice(0, 8).toUpperCase();
const hasPrivateManagement = state => Number.isSafeInteger(state.installationCount) && state.installationCount >= 0
  && typeof state.primaryReady === 'boolean';
let loggedIn = false, requestRunning = false, listSnapshot = '', primaryId, namingDevice;

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').dataset.error = String(error);
  $('notice').hidden = !text;
}
function showLogin() {
  loggedIn = false;
  $('login').hidden = false;
  $('dashboard').hidden = $('preview').hidden = true;
  for (const id of ['invite-code', 'update-code', 'private-credential']) $(id).value = '';
  $('issued').hidden = $('updated').hidden = $('credential-issued').hidden = true;
  $('change-password').reset();
  $('password-message').hidden = true;
  closeDeviceName();
}
async function api(path, body) {
  const response = await fetch('/admin/' + path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store',
  });
  const result = await response.json();
  if (response.ok) return result;
  if (result.error === 'admin_required') showLogin();
  throw new Error(messages[result.error] ?? '管理请求失败');
}
function showTlsFields() {
  $('cert-fields').hidden = !enabled('tls');
  $('redirect-field').hidden = !enabled('redirect');
}
function toggle(id, value) { $(id).setAttribute('aria-checked', String(value)); }
function fillNetwork(active) {
  $('port').value = active.port;
  $('domain').value = active.domain;
  toggle('tls', active.tls);
  toggle('redirect', Boolean(active.redirectPort));
  $('redirect-port').value = active.redirectPort || 17432;
  showTlsFields();
}
function showCertificate(active, candidate) {
  const certificate = $('certificate-status');
  const expires = Date.parse(active.certificateExpires ?? (candidate?.listening ? candidate.certificateExpires : ''));
  certificate.hidden = !Number.isFinite(expires);
  if (certificate.hidden) return;
  const hours = (expires - Date.now()) / 3600000;
  const remaining = hours <= 0 ? '已过期' : hours < 24 ? `剩余 ${Math.ceil(hours)} 小时` : `剩余 ${Math.floor(hours / 24)} 天`;
  certificate.textContent = `SSL 证书${remaining} · 到期时间 ${displayTime(expires)}`;
  certificate.dataset.expiring = String(hours <= 7 * 24);
}
let availableServerVersion;
function showServerUpdate(update) {
  const actions = $('server-update-actions');
  actions.hidden = !update?.configured;
  availableServerVersion = update?.phase === 'available' && !update.pending ? update.latest : null;
  $('server-update-install').disabled = !availableServerVersion;
  $('server-update-check').disabled = Boolean(update?.pending || ['checking', 'installing'].includes(update?.phase));
  const current = update?.current ? '当前 v' + update.current : '当前未标记版本';
  if (actions.hidden) {
    $('server-update-status').textContent = current + ' · 此安装未启用自更新';
    return;
  }
  const messages = {
    checking: '正在检查 GitHub', installing: '正在安装并重启服务端', up_to_date: '已是最新版本',
    available: '可更新至 v' + update.latest, failed: update.error || '更新请求失败',
  };
  $('server-update-status').textContent = current + ' · ' + (update.pending ? '更新请求已排队' : messages[update.phase] ?? '等待检查');
}
function setSubmit(form, action) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    try { await action(); }
    catch (error) { notice(error.message, true); }
    finally {
      if (button) button.disabled = form === $('network') && !$('migration').hidden
        || form === $('public-enable') && !canConvert;
    }
  });
}
function button(name, action, kind) {
  const result = document.createElement('button');
  result.type = 'button';
  result.textContent = name;
  if (kind) result.className = kind;
  result.addEventListener('click', async () => {
    result.disabled = true;
    try { await action(); }
    catch (error) { notice(error.message, true); }
    finally { result.disabled = false; }
  });
  return result;
}
function paragraph(text) { const node = document.createElement('p'); node.textContent = text; return node; }
function entry(text, ...actions) {
  const element = document.createElement('div');
  element.className = 'entry-row';
  element.append(typeof text === 'string' ? paragraph(text) : text);
  if (actions.length) {
    const group = document.createElement('div');
    group.className = 'entry-actions';
    group.append(...actions);
    element.append(group);
  }
  return element;
}
function revoke(type, id, label, confirmText = '撤销后将无法继续使用这项授权。确认撤销？') {
  return button(label, async () => {
    if (!window.confirm(confirmText)) return;
    render(await api('revoke', { type, id }));
    notice('已撤销');
  }, 'danger');
}
function closeDeviceName() {
  namingDevice = null;
  $('device-name').value = '';
  $('name-device').hidden = true;
}
function editDeviceName(device) {
  namingDevice = device.id;
  $('device-name').value = device.deviceName ?? '';
  $('name-device').hidden = false;
  $('device-name').focus();
}
const accountLabel = account => account.label || '账号 ' + short(account.id);

function renderDevices(state, accounts, supportsManagement) {
  const accountsById = new Map(accounts.filter(account => !account.recoverUntil).map(account => [account.id, account]));
  const installations = new Map();
  for (const device of state.devices) {
    const account = accountsById.get(device.account);
    if (!account) continue;
    const id = device.installation || device.id;
    const group = installations.get(id) ?? { device, labels: new Set(), activeLabels: new Set() };
    const label = accountLabel(account);
    group.labels.add(label);
    if (!device.revoked && !account.revoked) {
      if (!group.activeLabels.size) group.device = device;
      group.activeLabels.add(label);
    }
    installations.set(id, group);
  }
  const groups = [...installations.values()].sort((a, b) => Number(Boolean(b.activeLabels.size)) - Number(Boolean(a.activeLabels.size)));
  const rows = groups.map(({ device, labels, activeLabels }) => {
    const active = activeLabels.size > 0;
    const description = [device.client, device.system].filter(Boolean).join(' · ');
    const identity = document.createElement('div');
    identity.className = 'device-identity';
    identity.append(paragraph(device.deviceName || description || '未识别的设备'),
      paragraph([device.deviceName && description, [...(active ? activeLabels : labels)].join('、'), !active && '已撤销'].filter(Boolean).join(' · ')));
    const actions = [];
    if (device.deviceName !== undefined) actions.push(button('设备改名', () => editDeviceName(device)));
    if (active) {
      actions.push(button('生成地址更新码', async () => {
        const result = await api('update-code', { id: device.id });
        $('update-code').value = result.code;
        $('updated').hidden = false;
      }));
      if (supportsManagement) actions.push(device.privateDevice
        ? revoke('installation', device.id, '解除此安装', '解除后，该安装中的所有账号会停止同步。继续？')
        : revoke('device', device.id, '撤销设备'));
    }
    return entry(identity, ...actions);
  });
  $('devices').replaceChildren(...rows);
  $('device-management').hidden = !rows.length;
}
function renderLists(state) {
  $('migration-accounts').replaceChildren(...state.migration.map(row => entry(
    `${row.label} · ${row.ready ? '加密副本已就绪' : '等待工具箱准备'}`,
    ...(row.hasStage ? [button('重置准备', async () => {
      if (!window.confirm('重置后，此账号需要在工具箱重新准备历史。继续？')) return;
      render(await api('public/reset-stage', { key: row.key }));
    }, 'danger')] : []))));
  $('accounts').replaceChildren();
  $('devices').replaceChildren();
  $('device-management').hidden = true;
  if (state.mode === 'public') {
    closeDeviceName();
    for (const vault of state.vaults) $('accounts').append(entry(
      `${short(vault.id)} · ${vault.revoked ? '已解除' : Math.ceil(vault.bytes / 1024) + ' KB 密文'}`,
      ...(vault.revoked ? [] : [button('移除账号', async () => {
        if (!window.confirm('移除后会释放一个绑定名额，该账号的同步和分享凭据均会失效。继续？')) return;
        render(await api('public/revoke', { id: vault.id }));
      }, 'danger')])));
    if (!state.vaults.length) $('accounts').append(paragraph('暂无公共绑定'));
    return;
  }
  const supportsManagement = hasPrivateManagement(state);
  const accounts = [...state.accounts].sort((a, b) => Number(b.role === 'main') - Number(a.role === 'main'));
  for (const account of accounts) {
    const block = document.createElement('div');
    const label = accountLabel(account);
    if (account.recoverUntil) {
      $('accounts').append(entry(`${label} · 已移除 · 可恢复至 ${displayTime(account.recoverUntil)}`,
        ...(state.primaryReady && state.active < 5 ? [button('恢复账号及数据', async () => {
          render(await api('private/restore-child', { id: account.id }));
          notice('账号及历史已恢复');
        })] : [])));
      continue;
    }
    const actions = [];
    if (!account.revoked) {
      if (account.role === 'child') actions.push(button('设为主账号', async () => {
        if (!window.confirm(`将主账号转交给 ${label}？原主账号将成为附属账号，已生成的主账号凭据会失效。`)) return;
        render(await api('private/promote-child', { id: account.id }));
        notice('主账号已转交');
      }), revoke('account', account.id, '移除账号', '移除此账号及其账本和战绩？移除后 30 天内可恢复。'));
      if (!account.role && supportsManagement) actions.push(revoke('account', account.id, '解除账号'));
    }
    const identity = paragraph('');
    identity.className = 'account-identity';
    if (account.role === 'main' || account.role === 'child') {
      const badge = document.createElement('span');
      badge.className = 'account-role';
      badge.textContent = account.role === 'main' ? '主账号' : '附属账号';
      identity.append(badge);
    }
    const accountName = document.createElement('span');
    accountName.className = 'account-name';
    accountName.textContent = account.revoked ? label + ' · 已解除' : label;
    identity.append(accountName);
    if (account.role === 'main') block.className = 'primary-account';
    block.append(entry(identity, ...actions));
    $('accounts').append(block);
  }
  renderDevices(state, accounts, supportsManagement);
  if (!state.accounts.length) $('accounts').append(paragraph('暂无已绑定账号'));
  for (const row of state.existingAccounts) $('accounts').append(entry(row.label + ' · 历史待关联'));
}
let canConvert = false;
const initialSetup = document.body.hasAttribute('data-initial-setup');
if (initialSetup) {
  $('login-label').textContent = '首次设置码';
  $('login-hint').textContent = '输入安装程序显示的首次设置码。管理员密码在 HTTPS 或回环管理页使用。';
  $('token').autocomplete = 'off';
  $('domain-label').textContent = '同步域名';
  $('domain').placeholder = 'sync.example.com';
}
function renderSetup(state, resetSettings) {
  const shared = state.mode === 'public', active = state.activeEndpoint, candidate = state.candidate;
  $('preview').hidden = $('installation-card').hidden = $('security-card').hidden = $('accounts-card').hidden = true;
  $('update-settings').hidden = $('public-mode').hidden = $('pem-files').hidden = true;
  $('private-mode').hidden = shared || state.used;
  $('setup-pem-hint').hidden = $('setup-hint').hidden = false;
  $('server-mode').textContent = shared ? '公共' : '私有';
  $('network-scope').textContent = '首次设置';
  $('setup-hint').textContent = shared ? '用安装程序显示的管理员密码登录 HTTPS 管理面板。登录成功后，此 HTTP 入口关闭。'
    : '配置公网域名和 HTTPS 端口后，可将此实例转为公共服务器。';
  $('setup-https').hidden = !shared || !state.publicUrl;
  if (!$('setup-https').hidden) $('setup-https').href = state.publicUrl + '/admin/';
  $('network').hidden = shared || state.used;
  $('active-address').textContent = '同步端口 ' + active.port;
  $('migration').hidden = !candidate || shared;
  $('candidate').textContent = candidate ? '新 HTTPS 端口 ' + candidate.port : '';
  $('save-network').disabled = Boolean(candidate);
  canConvert = state.httpsReady && !state.used;
  $('enable-public-button').disabled = !canConvert;
  $('transition-readiness').textContent = canConvert ? 'HTTPS 已强制启用，可以转为公共服务器。' : '请先配置有效的 SSL 证书和 HTTPS 端口。';
  if (resetSettings) {
    fillNetwork(candidate || { ...active, port: 8888, tls: true });
    $('tls').disabled = true;
  }
  showCertificate(active, candidate);
}
function render(state, resetSettings = false) {
  loggedIn = true;
  $('login').hidden = true;
  const shared = state.mode === 'public', bound = state.installationBound;
  const supportsManagement = hasPrivateManagement(state);
  const waitingForUpdate = !shared && !supportsManagement && bound;
  $('dashboard').hidden = false;
  if (state.initialSetup) { renderSetup(state, resetSettings); return; }
  $('preview').hidden = shared;
  $('private-mode').hidden = $('installation-card').hidden = shared;
  $('public-mode').hidden = !shared;
  $('server-mode').textContent = shared ? '公共' : '私有';
  $('network-scope').textContent = state.httpsRequired ? '强制 HTTPS' : state.privateNetwork ? '可配置网络访问' : '仅本机';
  $('public-url').value = state.publicUrl || '';
  toggle('public-preview', state.publicPreview);
  canConvert = state.httpsReady && !state.recoveryPending && state.migration.every(row => row.ready);
  $('enable-public-button').disabled = !canConvert;
  $('transition-readiness').textContent = !state.httpsReady ? '请先配置有效的 SSL 证书和 HTTPS 端口。'
    : state.recoveryPending ? '有账号处于 30 天恢复期。恢复账号或等待恢复期结束后可转换。'
    : state.migration.some(row => !row.ready) ? '用有历史的游戏账号登录工具箱，在「云同步」里准备转换，直至所有账号就绪。'
      : 'HTTPS 已强制启用，已有历史均已就绪。';
  $('credential-panel').hidden = !state.primaryReady;
  $('private-upgrade').hidden = !waitingForUpdate;
  $('invite').hidden = $('pairing-hint').hidden = waitingForUpdate;
  $('release-installation').hidden = !bound || !supportsManagement;
  const installationStatus = supportsManagement ? `已绑定 ${state.installationCount} 个安装` : '已绑定 · 安装数待确认';
  $('installation-status').textContent = bound ? installationStatus : '等待配对';
  const currentMain = state.accounts.find(row => row.role === 'main')?.id;
  if (currentMain !== primaryId) {
    primaryId = currentMain;
    $('private-credential').value = '';
    $('credential-issued').hidden = true;
  }
  if (shared) $('issued').hidden = $('updated').hidden = true;
  const active = state.activeEndpoint, candidate = state.candidate;
  showCertificate(active, candidate);
  $('active-address').textContent = state.httpsRequired && !active.tls && state.publicUrl
    ? `HTTPS 同步 ${state.publicUrl} · 旧 HTTP 端口 ${active.port} 等待退役`
    : `当前 ${active.tls ? 'HTTPS' : 'HTTP'} · ${active.domain || '127.0.0.1'}:${active.port}`;
  const updates = state.updates;
  toggle('mirror', Boolean(updates?.enabled));
  $('mirror').disabled = !updates;
  $('mirror-status').textContent = !updates ? '重启服务后可配置更新镜像。'
    : !updates.enabled ? '更新镜像已停用。'
    : [updates.version ? '已缓存核心 v' + updates.version : '等待首次同步', updates.checking ? '正在检查 GitHub' : '每分钟检查 GitHub',
      updates.updatedAt && '上次同步 ' + displayTime(updates.updatedAt), updates.error].filter(Boolean).join(' · ');
  $('mirror-address').hidden = !updates?.enabled;
  $('mirror-address').textContent = updates?.url ?? '';
  showServerUpdate(state.serverUpdate);
  $('migration').hidden = !candidate;
  $('cancel-migration').disabled = shared && !active.tls;
  $('tls').disabled = state.httpsRequired;
  $('save-network').disabled = Boolean(candidate);
  if (candidate) {
    const status = candidate.error ? messages[candidate.error] ?? '等待恢复'
      : candidate.deadline ? `旧端口将于 ${displayTime(candidate.deadline)} 关闭` : '等待工具箱在新端口认证';
    $('candidate').textContent = `新端口 ${candidate.port} · ${status}`;
  }
  const publicAccounts = state.publicAccounts;
  $('public-account-settings').hidden = !shared || !publicAccounts;
  const publicLimit = $('public-account-limit');
  if (publicAccounts) {
    const limit = String(publicAccounts.limit);
    if (resetSettings || publicLimit.value === publicLimit.defaultValue) publicLimit.value = limit;
    publicLimit.defaultValue = limit;
  }
  $('slots').textContent = shared
    ? publicAccounts ? `已绑定 ${publicAccounts.active} / ${publicAccounts.limit}` : ''
    : `已绑定 ${state.active} / 5`;
  $('accounts-heading').textContent = shared ? '公共绑定' : '账号';
  if (resetSettings) fillNetwork(candidate || active);
  const snap = JSON.stringify([state.mode, supportsManagement, state.primaryReady, state.active, state.accounts, state.devices, state.vaults, state.migration, state.existingAccounts]);
  if (snap !== listSnapshot) { listSnapshot = snap; renderLists(state); }
}
async function refresh(resetSettings = false) {
  if (requestRunning) return;
  requestRunning = true;
  try { render(await api('status'), resetSettings); }
  catch (error) { if (loggedIn) notice(error.message, true); }
  finally { requestRunning = false; }
}
async function copy(id) {
  const control = $(id);
  try { await navigator.clipboard.writeText(control.value); notice('已复制'); }
  catch { control.focus(); control.select(); notice('已选中文本，请手动复制'); }
}

setSubmit($('login'), async () => {
  await api('login', { token: $('token').value });
  $('token').value = '';
  render(await api('status'), true);
  notice('');
});

setSubmit($('change-password'), async () => {
  const message = $('password-message');
  message.hidden = true;
  const current = $('current-password').value;
  const password = $('new-password').value;
  try {
    if (password !== $('confirm-password').value) throw new Error('两次输入的新密码不一致');
    await api('password', { current, password });
    showLogin();
    $('token').focus();
    notice('密码已保存，请用新密码登录');
  } catch (error) {
    if (!loggedIn) throw error;
    message.textContent = error.message;
    message.dataset.error = 'true';
    message.hidden = false;
  }
});
setSubmit($('network'), async () => {
  const tls = enabled('tls');
  const certFile = $('cert').files[0], keyFile = $('key').files[0];
  if (tls && (certFile?.size > 65536 || keyFile?.size > 16384)) throw new Error('证书文件过大');
  const state = await api('network', { port: number('port'), domain: $('domain').value, tls,
    redirectPort: tls && enabled('redirect') ? number('redirect-port') : 0,
    cert: tls ? await certFile?.text() : undefined, key: tls ? await keyFile?.text() : undefined });
  $('cert').value = $('key').value = '';
  render(state, true);
  notice(state.candidate ? '新端口已启动，等待工具箱认证' : '网络设置已保存');
});
setSubmit($('invite'), async () => {
  const result = await api('private/invite', { pin: $('request').value.trim() });
  $('invite-code').value = result.code;
  $('request').value = '';
  $('issued').hidden = false;
  notice('加密凭据已生成');
});
setSubmit($('public-enable'), async () => {
  render(await api('public/enable', { confirm: $('confirm-public').value.trim() }), true);
  $('confirm-public').value = '';
  notice('已转为公共服务器');
});
setSubmit($('public-account-settings'), async () => {
  const state = await api('public/limit', { limit: number('public-account-limit') });
  render(state);
  $('public-account-limit').value = state.publicAccounts.limit;
  notice('已保存绑定上限');
});
async function perform(action) {
  try { await action(); }
  catch (error) { notice(error.message, true); }
}
$('public-preview').addEventListener('click', () => void perform(async () => {
  render(await api('public/preview', { enabled: !enabled('public-preview') }));
  notice('已保存预览权限');
}));
$('release-installation').addEventListener('click', () => void perform(async () => {
  if (!window.confirm('解除后，所有设备的同步和私有查看链接都会失效，历史会保留。继续？')) return;
  render(await api('release-installation', {}));
  notice('已解除整个私有绑定');
}));
$('generate-credential').addEventListener('click', event => {
  const button = event.currentTarget;
  button.disabled = true;
  void perform(async () => {
    const result = await api('private/credential', {});
    $('private-credential').value = result.code;
    $('credential-issued').hidden = false;
    notice('主账号凭据已生成');
  }).finally(() => { button.disabled = false; });
});
for (const id of ['tls', 'redirect']) $(id).addEventListener('click', () => { toggle(id, !enabled(id)); showTlsFields(); });
$('mirror').addEventListener('click', event => {
  const button = event.currentTarget;
  button.disabled = true;
  void perform(async () => { render(await api('updates', { enabled: !enabled('mirror') })); })
    .finally(() => { button.disabled = false; });
});
$('server-update-check').addEventListener('click', () => void perform(async () => {
  render(await api('server-update', { action: 'check' }));
}));
$('server-update-install').addEventListener('click', () => void perform(async () => {
  const version = availableServerVersion;
  if (version && window.confirm(`安装服务端 v${version} 后将暂时断开连接并需要重新登录。继续？`)) {
    render(await api('server-update', { action: 'install', version }));
  }
}));
$('copy-code').addEventListener('click', () => void copy('invite-code'));
$('copy-private-credential').addEventListener('click', () => void copy('private-credential'));
$('copy-update').addEventListener('click', () => void copy('update-code'));
$('cancel-device-name').addEventListener('click', closeDeviceName);
setSubmit($('name-device'), async () => {
  render(await api('device/name', { id: namingDevice, name: $('device-name').value }));
  closeDeviceName();
  notice('设备名称已保存');
});
$('copy-public-url').addEventListener('click', () => void copy('public-url'));
$('cancel-migration').addEventListener('click', async () => {
  try { render(await api('cancel', {}), true); notice('已取消切换'); }
  catch (error) { notice(error.message, true); }
});
showLogin();
void refresh(true);
setInterval(() => { if (loggedIn) void refresh(); }, 4000);
