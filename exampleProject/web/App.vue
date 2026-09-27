<script setup lang="ts">
import { ref, onMounted } from 'vue';
const user = ref<{ username: string } | null>(null);
const username = ref(''), password = ref(''), error = ref('');
const busy = ref(false), loading = ref(true);
async function request(path: string, body?: unknown) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '请求失败');
  return data;
}
onMounted(async () => {
  try {
    const response = await fetch('/api/me');
    if (response.ok) user.value = await response.json();
    else if (response.status !== 401) error.value = '服务暂不可用，请刷新重试';
  } catch { error.value = '无法连接服务，请刷新重试'; }
  finally { loading.value = false; }
});
async function login() {
  busy.value = true; error.value = '';
  try { user.value = await request('login', { username: username.value, password: password.value }); password.value = ''; }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
async function logout() {
  busy.value = true; error.value = '';
  try { await request('logout', {}); user.value = null; }
  catch (e) { error.value = (e as Error).message; }
  finally { busy.value = false; }
}
</script>
<template>
  <main>
    <aside><span class="brand">EXAMPLE / 01</span><h1>一个简单的开始。</h1><p>独立账号，一个属于你的登录示例。</p><small>Deployed with geli</small></aside>
    <section aria-label="账号登录">
      <p v-if="loading">正在恢复登录状态…</p>
      <template v-else-if="user"><span class="badge">已登录</span><h2>你好，{{ user.username }}</h2><p>登录成功。刷新页面后，会话仍然有效。</p><button :disabled="busy" @click="logout">退出登录</button></template>
      <form v-else @submit.prevent="login"><span class="badge">WELCOME BACK</span><h2>登录账号</h2><p>请输入本示例独立的账号和密码。</p><label for="username">用户名</label><input id="username" v-model="username" required maxlength="80" autocomplete="username"><label for="password">密码</label><input id="password" v-model="password" type="password" required maxlength="200" autocomplete="current-password"><button :disabled="busy">{{ busy ? '正在登录…' : '登录' }}</button></form>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
    </section>
  </main>
</template>

