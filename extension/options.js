import { SyncManager } from './sync/sync-manager.js';

let activeProvider = 'none';

document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentSettings();
  setupEvents();

  // Listen for sync status events from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SYNC_STATUS_CHANGED' && message.status) {
      updateStatusUI(message.status);
    }
  });
});

async function loadCurrentSettings() {
  const { config, status } = await SyncManager.getConfig();

  activeProvider = config.provider || 'none';
  switchTab(activeProvider);

  // WebDAV fields
  const wd = config.webdav || {};
  document.getElementById('webdav-url').value = wd.serverUrl || '';
  document.getElementById('webdav-user').value = wd.username || '';
  document.getElementById('webdav-pass').value = wd.password || '';
  document.getElementById('webdav-path').value = wd.pathPrefix || 'selfhub_sync';

  // S3 fields
  const s3 = config.s3 || {};
  document.getElementById('s3-endpoint').value = s3.endpoint || '';
  document.getElementById('s3-bucket').value = s3.bucket || '';
  document.getElementById('s3-region').value = s3.region || 'auto';
  document.getElementById('s3-ak').value = s3.accessKeyId || '';
  document.getElementById('s3-sk').value = s3.secretAccessKey || '';
  document.getElementById('s3-path').value = s3.pathPrefix || 'selfhub_sync';

  // Auto-sync toggle
  document.getElementById('auto-sync-toggle').checked = config.autoSync !== false;

  updateStatusUI(status);
}

function updateStatusUI(status) {
  const badgeEl = document.getElementById('sync-status-badge');
  const timeEl = document.getElementById('status-last-time');
  const msgEl = document.getElementById('status-last-msg');

  if (!status) return;

  badgeEl.className = 'badge';
  if (status.state === 'syncing') {
    badgeEl.classList.add('badge-syncing');
    badgeEl.textContent = '🟡 同步中...';
  } else if (status.state === 'success') {
    badgeEl.classList.add('badge-success');
    badgeEl.textContent = '🟢 同步正常';
  } else if (status.state === 'error') {
    badgeEl.classList.add('badge-error');
    badgeEl.textContent = '🔴 同步失败';
  } else {
    badgeEl.classList.add('badge-idle');
    badgeEl.textContent = '⚪ 就绪';
  }

  if (status.lastSyncTime) {
    const d = new Date(status.lastSyncTime);
    timeEl.textContent = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } else {
    timeEl.textContent = '从未同步';
  }

  msgEl.textContent = status.lastMessage || '--';
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function switchTab(provider) {
  activeProvider = provider;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.provider === provider);
  });

  document.getElementById('section-none').style.display = provider === 'none' ? 'block' : 'none';
  document.getElementById('section-webdav').style.display = provider === 'webdav' ? 'flex' : 'none';
  document.getElementById('section-s3').style.display = provider === 's3' ? 'flex' : 'none';
}

function collectConfigFromUI() {
  return {
    provider: activeProvider,
    autoSync: document.getElementById('auto-sync-toggle').checked,
    cooldownSec: 60,
    webdav: {
      serverUrl: document.getElementById('webdav-url').value.trim(),
      username: document.getElementById('webdav-user').value.trim(),
      password: document.getElementById('webdav-pass').value.trim(),
      pathPrefix: document.getElementById('webdav-path').value.trim() || 'selfhub_sync'
    },
    s3: {
      endpoint: document.getElementById('s3-endpoint').value.trim(),
      bucket: document.getElementById('s3-bucket').value.trim(),
      region: document.getElementById('s3-region').value.trim() || 'auto',
      accessKeyId: document.getElementById('s3-ak').value.trim(),
      secretAccessKey: document.getElementById('s3-sk').value.trim(),
      pathPrefix: document.getElementById('s3-path').value.trim() || 'selfhub_sync'
    }
  };
}

function setupEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.provider));
  });

  // Save Config
  document.getElementById('save-btn').addEventListener('click', async () => {
    const config = collectConfigFromUI();
    await SyncManager.saveConfig(config);
    const msgEl = document.getElementById('save-msg');
    msgEl.textContent = '✅ 配置已成功保存！';
    setTimeout(() => { msgEl.textContent = ''; }, 3000);
  });

  // Test Connection
  document.getElementById('test-conn-btn').addEventListener('click', async () => {
    const config = collectConfigFromUI();
    const feedbackEl = document.getElementById('test-feedback');

    if (activeProvider === 'none') {
      feedbackEl.style.color = '#eab308';
      feedbackEl.textContent = '当前为仅本机离线模式，无需测试云端连接。';
      return;
    }

    if (activeProvider === 's3') {
      const { endpoint, bucket, accessKeyId, secretAccessKey } = config.s3;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        feedbackEl.style.color = '#ef4444';
        feedbackEl.textContent = '请先完整填写 S3 Endpoint、Bucket、Access Key 和 Secret Key！';
        return;
      }
    } else if (activeProvider === 'webdav') {
      const { serverUrl, username, password } = config.webdav;
      if (!serverUrl || !username || !password) {
        feedbackEl.style.color = '#ef4444';
        feedbackEl.textContent = '请先完整填写 WebDAV 服务器地址、用户名和密码！';
        return;
      }
    }

    feedbackEl.style.color = '#a1a1aa';
    feedbackEl.textContent = '正在测试读写与授权凭据...';

    const subConfig = activeProvider === 's3' ? config.s3 : config.webdav;
    const result = await SyncManager.testConnection(activeProvider, subConfig);

    if (result.success) {
      feedbackEl.style.color = '#10b981';
      feedbackEl.textContent = `✅ ${result.message}`;
    } else {
      feedbackEl.style.color = '#ef4444';
      feedbackEl.textContent = `❌ ${result.message}`;
    }
  });

  // Sync Now
  document.getElementById('sync-now-btn').addEventListener('click', () => {
    const feedbackEl = document.getElementById('test-feedback');
    feedbackEl.style.color = '#eab308';
    feedbackEl.textContent = '已触发立即同步，正在处理...';

    chrome.runtime.sendMessage({ action: 'PERFORM_SYNC', force: true }, (res) => {
      if (res && res.success) {
        feedbackEl.style.color = '#10b981';
        feedbackEl.textContent = `✅ ${res.message}`;
      } else {
        feedbackEl.style.color = '#ef4444';
        feedbackEl.textContent = `❌ ${res ? res.message : '同步执行失败'}`;
      }
    });
  });
}
