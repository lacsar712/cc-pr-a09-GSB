import { useCallback, useEffect, useState } from 'react'

export default function App() {
  const [username, setUsername] = useState('printer')
  const [password, setPassword] = useState('print123456')
  const [token, setToken] = useState(localStorage.getItem('print_token') || '')
  const [role, setRole] = useState(localStorage.getItem('print_role') || '')
  const [view, setView] = useState('jobs')
  const [error, setError] = useState('')

  const api = useCallback(async (path, options = {}) => {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (res.status === 204) return null
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.detail || '请求失败')
    return data
  }, [token])

  async function enter() {
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || '登录失败')
      localStorage.setItem('print_token', data.access_token)
      localStorage.setItem('print_role', data.role)
      setToken(data.access_token)
      setRole(data.role)
    } catch (err) {
      setError(err.message)
    }
  }

  function leave() {
    localStorage.clear()
    setToken('')
    setRole('')
    setView('jobs')
  }

  if (!token) {
    return (
      <main className="page">
        <h1>印刷套准复核台</h1>
        <p>提交后接口只入队。另一进程领走偏差并写结论，页面轮询到结论出现。</p>
        <p>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={enter}>登录</button>
        </p>
        {error && <p className="error">{error}</p>}
        <p>printer / print123456 可送复核、维护前缀；checker / check123456 只看</p>
      </main>
    )
  }

  return (
    <main className="page">
      <TopBar view={view} setView={setView} onLeave={leave} />
      {view === 'jobs' ? <JobsPage api={api} role={role} /> : <PrefixPage api={api} role={role} />}
    </main>
  )
}

function TopBar({ view, setView, onLeave }) {
  return (
    <nav className="topbar">
      <strong>印刷套准复核台</strong>
      <button className={view === 'jobs' ? 'active' : ''} onClick={() => setView('jobs')}>
        复核台
      </button>
      <button className={view === 'prefixes' ? 'active' : ''} onClick={() => setView('prefixes')}>
        前缀白名单
      </button>
      <button className="logout" onClick={onLeave}>退出</button>
    </nav>
  )
}

function JobsPage({ api, role }) {
  const [rows, setRows] = useState([])
  const [sheet, setSheet] = useState('封面-02')
  const [cyan, setCyan] = useState('0.08')
  const [magenta, setMagenta] = useState('0.02')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const load = useCallback(async () => {
    setRows(await api('/api/jobs'))
  }, [api])

  useEffect(() => {
    load().catch(() => {})
    const timer = setInterval(() => load().catch(() => {}), 1000)
    return () => clearInterval(timer)
  }, [load])

  async function send() {
    setError('')
    setOk('')
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ sheet, cyan_mm: Number(cyan), magenta_mm: Number(magenta) }),
      })
      setOk(`印张「${sheet}」已入队`)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section>
      {role === 'writer' && (
        <p className="submit-row">
          <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="印张名" />
          <input value={cyan} onChange={(e) => setCyan(e.target.value)} placeholder="青偏差" />
          <input value={magenta} onChange={(e) => setMagenta(e.target.value)} placeholder="品偏差" />
          <button onClick={send}>送复核</button>
        </p>
      )}
      {error && <p className="error">退回：{error}</p>}
      {ok && <p className="ok">{ok}</p>}
      <table>
        <thead>
          <tr><th>印张</th><th>青</th><th>品</th><th>状态</th><th>结论</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.sheet}</td>
              <td>{row.cyan_mm}</td>
              <td>{row.magenta_mm}</td>
              <td>{row.status}</td>
              <td>{row.verdict || '等待'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function PrefixPage({ api, role }) {
  const writer = role === 'writer'
  const [prefixes, setPrefixes] = useState([])
  const [history, setHistory] = useState([])
  const [rejected, setRejected] = useState([])
  const [newPrefix, setNewPrefix] = useState('')
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  const load = useCallback(async () => {
    const [p, h, r] = await Promise.all([
      api('/api/prefixes'),
      api('/api/prefix-history'),
      api('/api/rejected-submissions/today'),
    ])
    setPrefixes(p)
    setHistory(h)
    setRejected(r)
  }, [api])

  useEffect(() => {
    load().catch((err) => setError(err.message))
    const timer = setInterval(() => load().catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [load])

  async function addPrefix() {
    setError('')
    setOk('')
    try {
      await api('/api/prefixes', { method: 'POST', body: JSON.stringify({ prefix: newPrefix }) })
      setOk(`已新增前缀「${newPrefix.trim()}」`)
      setNewPrefix('')
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function removePrefix(prefix) {
    setError('')
    setOk('')
    try {
      await api(`/api/prefixes/${encodeURIComponent(prefix)}`, { method: 'DELETE' })
      setOk(`已删除前缀「${prefix}」`)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section>
      <h2>前缀白名单</h2>
      <p className="hint">投递名必须以白名单中任一条目开头才予入队，否则当场退回；前缀增删均记入变更履历。</p>

      <h3>维护区</h3>
      {writer ? (
        <p className="submit-row">
          <input
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value)}
            placeholder="新前缀，如：内页"
          />
          <button onClick={addPrefix}>新增前缀</button>
        </p>
      ) : (
        <p className="hint">只读账号：可查看白名单与履历，不能维护。</p>
      )}
      {error && <p className="error">{error}</p>}
      {ok && <p className="ok">{ok}</p>}
      <ul className="prefix-list">
        {prefixes.map((p) => (
          <li key={p.prefix}>
            <code>{p.prefix}</code>
            <span className="muted">（{p.created_by} 于 {fmt(p.created_at)} 加入）</span>
            {writer && <button onClick={() => removePrefix(p.prefix)}>删除</button>}
          </li>
        ))}
        {prefixes.length === 0 && <li className="muted">白名单为空，所有投递都将被退回。</li>}
      </ul>

      <h3>当日退回样例</h3>
      <table>
        <thead>
          <tr><th>印张名</th><th>青</th><th>品</th><th>投递人</th><th>退回时间</th></tr>
        </thead>
        <tbody>
          {rejected.map((r) => (
            <tr key={r.id}>
              <td>{r.sheet}</td>
              <td>{r.cyan_mm}</td>
              <td>{r.magenta_mm}</td>
              <td>{r.submitted_by}</td>
              <td>{fmt(r.rejected_at)}</td>
            </tr>
          ))}
          {rejected.length === 0 && (
            <tr><td colSpan={5} className="muted">当日暂无退回样例。</td></tr>
          )}
        </tbody>
      </table>

      <h3>变更履历</h3>
      <table>
        <thead>
          <tr><th>变更</th><th>前缀</th><th>操作人</th><th>时间</th></tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.id}>
              <td>{h.action === 'add' ? '新增' : '删除'}</td>
              <td><code>{h.prefix}</code></td>
              <td>{h.changed_by}</td>
              <td>{fmt(h.changed_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function fmt(value) {
  if (!value) return ''
  const d = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
