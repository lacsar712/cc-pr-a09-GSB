import { useEffect, useState } from 'react'
import { api } from './api.js'

const ACTION_TEXT = { add: '新增', remove: '删除' }

export default function PrefixPage({ role }) {
  const [prefixes, setPrefixes] = useState([])
  const [audit, setAudit] = useState([])
  const [rejections, setRejections] = useState([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const writer = role === 'writer'

  async function load() {
    const [plist, alist, rlist] = await Promise.all([
      api('/api/prefixes'),
      api('/api/prefixes/audit'),
      api('/api/rejections/today'),
    ])
    setPrefixes(plist)
    setAudit(alist)
    setRejections(rlist)
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [])

  async function addPrefix() {
    setError('')
    try {
      await api('/api/prefixes', { method: 'POST', body: JSON.stringify({ prefix: draft }) })
      setDraft('')
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  async function removePrefix(prefix) {
    setError('')
    try {
      await api(`/api/prefixes/${encodeURIComponent(prefix)}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section>
      <h2>前缀白名单</h2>
      <p>投递名须以白名单中任一前缀开头，否则当场退回；已入队的旧任务不受之后删前缀影响。</p>

      <h3>维护区</h3>
      {writer ? (
        <p>
          <input
            value={draft}
            placeholder="新前缀"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button onClick={addPrefix}>新增前缀</button>
        </p>
      ) : (
        <p>只读账号：可查看白名单与履历，不能修改。</p>
      )}
      {error && <p>{error}</p>}
      <ul>
        {prefixes.map((row) => (
          <li key={row.id}>
            {row.prefix}{' '}
            {writer && <button onClick={() => removePrefix(row.prefix)}>删除</button>}
          </li>
        ))}
        {prefixes.length === 0 && <li>（白名单为空，所有投递都将退回）</li>}
      </ul>

      <h3>当日退回样例</h3>
      <table>
        <thead>
          <tr><th>投递名</th><th>青</th><th>品</th><th>原因</th><th>投递人</th><th>时间</th></tr>
        </thead>
        <tbody>
          {rejections.map((row) => (
            <tr key={row.id}>
              <td>{row.sheet}</td>
              <td>{row.cyan_mm}</td>
              <td>{row.magenta_mm}</td>
              <td>{row.reason}</td>
              <td>{row.rejected_by}</td>
              <td>{new Date(row.rejected_at).toLocaleString('zh-CN')}</td>
            </tr>
          ))}
          {rejections.length === 0 && (
            <tr><td colSpan={6}>当日暂无退回</td></tr>
          )}
        </tbody>
      </table>

      <h3>变更履历</h3>
      <table>
        <thead>
          <tr><th>动作</th><th>前缀</th><th>操作人</th><th>时间</th></tr>
        </thead>
        <tbody>
          {audit.map((row) => (
            <tr key={row.id}>
              <td>{ACTION_TEXT[row.action] || row.action}</td>
              <td>{row.prefix}</td>
              <td>{row.operator}</td>
              <td>{new Date(row.created_at).toLocaleString('zh-CN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
