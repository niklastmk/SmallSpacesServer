import React, { useState, useEffect } from 'react'
import { getCrashes, deleteCrash, getAdminKey, reclassifyCrashes, getCrashGroups, getCrashGroup, getCrashSummary } from '../api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, Cell, PieChart, Pie } from 'recharts'

// ============================================
// STYLES
// ============================================
const s = {
  container: { display: 'flex', flexDirection: 'column', gap: '20px' },
  card: { background: '#16181c', borderRadius: '12px', padding: '20px', border: '1px solid #2f3336' },
  subTabs: { display: 'flex', gap: '4px', background: '#16181c', borderRadius: '10px', padding: '4px', border: '1px solid #2f3336' },
  subTab: { background: 'transparent', border: 'none', color: '#71767b', padding: '8px 16px', cursor: 'pointer', fontSize: '13px', fontWeight: '500', borderRadius: '8px' },
  subTabActive: { background: '#1d9bf0', color: '#fff' },
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' },
  statCard: { background: '#1a1d21', borderRadius: '10px', padding: '16px', border: '1px solid #2f3336' },
  statValue: { fontSize: '28px', fontWeight: '700', color: '#e7e9ea' },
  statLabel: { fontSize: '12px', color: '#71767b', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  chartsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '16px', marginBottom: '20px' },
  chartCard: { background: '#16181c', borderRadius: '12px', padding: '20px', border: '1px solid #2f3336' },
  chartTitle: { fontSize: '14px', fontWeight: '600', color: '#e7e9ea', marginBottom: '16px' },
  groupCard: { background: '#16181c', borderRadius: '12px', border: '1px solid #2f3336', overflow: 'hidden', marginBottom: '12px' },
  groupHeader: { padding: '16px 20px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' },
  groupTitle: { fontSize: '14px', fontWeight: '600', color: '#e7e9ea', marginBottom: '4px', fontFamily: 'monospace' },
  groupDetail: { padding: '0 20px 20px', borderTop: '1px solid #2f3336' },
  detailLabel: { fontSize: '11px', color: '#71767b', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px', marginTop: '16px' },
  detailText: { fontSize: '13px', color: '#e7e9ea', lineHeight: '1.5', background: '#1a1d21', padding: '10px 14px', borderRadius: '8px' },
  tag: { display: 'inline-block', padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: '500', background: '#2f3336', color: '#e7e9ea' },
  tagList: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
  countBadge: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: '28px', height: '28px', borderRadius: '14px', fontSize: '13px', fontWeight: '700', background: '#2f3336', color: '#e7e9ea' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '12px 8px', borderBottom: '1px solid #2f3336', color: '#71767b', fontSize: '12px', fontWeight: '500' },
  td: { padding: '12px 8px', borderBottom: '1px solid #2f3336', color: '#e7e9ea', fontSize: '13px', verticalAlign: 'top' },
  clickableRow: { cursor: 'pointer' },
  expandedRow: { background: '#1a1d21' },
  detailsCell: { padding: '16px', background: '#1a1d21' },
  detailsGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' },
  detailItem: { background: '#2f3336', padding: '8px 12px', borderRadius: '6px' },
  detailItemLabel: { fontSize: '11px', color: '#71767b', marginBottom: '2px' },
  detailItemValue: { fontSize: '13px', color: '#e7e9ea', wordBreak: 'break-all' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '500' },
  actionBtn: { background: '#1d9bf0', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', marginRight: '6px' },
  deleteBtn: { background: '#dc3545', border: 'none', color: '#fff', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' },
  refreshBtn: { background: '#2f3336', border: 'none', color: '#e7e9ea', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' },
  emptyState: { textAlign: 'center', padding: '48px 24px', color: '#71767b' },
  emptyTitle: { fontSize: '16px', fontWeight: '600', color: '#e7e9ea', marginBottom: '8px' },
  loading: { textAlign: 'center', padding: '40px', color: '#71767b' },
  error: { background: '#67000d', color: '#ff6b6b', padding: '12px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px' },
  miniTable: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
  miniTh: { textAlign: 'left', padding: '8px 6px', borderBottom: '1px solid #2f3336', color: '#71767b', fontSize: '11px', fontWeight: '500' },
  miniTd: { padding: '8px 6px', borderBottom: '1px solid #2f3336', color: '#e7e9ea', fontSize: '12px' },
  topGroupCard: { background: '#1a1d21', borderRadius: '8px', padding: '12px 16px', border: '1px solid #2f3336', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
}

const CRASH_TYPE_COLORS = {
  OutOfMemory: '#ef4444', Assert: '#f59e0b', Ensure: '#8b5cf6', Hang: '#ea580c',
  GPUCrash: '#3b82f6', Crash: '#ec4899', Other: '#6b7280', Unknown: '#374151'
}
const SEVERITY_COLORS = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#2563eb' }
const PIE_COLORS = ['#ef4444', '#f59e0b', '#8b5cf6', '#ea580c', '#3b82f6', '#ec4899', '#10b981', '#6b7280']
const TOOLTIP_STYLE = { background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}
function formatDate(d) { return new Date(d).toLocaleString() }
function formatShortDate(d) { return new Date(d).toLocaleDateString() }

function CrashTypeBadge({ type }) {
  const color = CRASH_TYPE_COLORS[type] || CRASH_TYPE_COLORS.Other
  return <span style={{ ...s.badge, background: color + '22', color }}>{type}</span>
}
function SeverityBadge({ severity }) {
  return <span style={{ ...s.badge, background: SEVERITY_COLORS[severity] || '#2f3336', color: '#fff' }}>{severity}</span>
}

// ============================================
// OVERVIEW
// ============================================
function CrashOverview({ summary, loading }) {
  if (loading) return <div style={s.loading}>Loading...</div>
  if (!summary || summary.total_crashes === 0) {
    return <div style={s.emptyState}><div style={s.emptyTitle}>No crash reports yet</div></div>
  }

  return (
    <div>
      <div style={s.statsGrid}>
        <div style={s.statCard}><div style={s.statValue}>{summary.total_crashes}</div><div style={s.statLabel}>Total</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.crashes_today}</div><div style={s.statLabel}>Today</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.crashes_this_week}</div><div style={s.statLabel}>This Week</div></div>
        <div style={s.statCard}><div style={s.statValue}>{summary.total_groups}</div><div style={s.statLabel}>Unique Issues</div></div>
      </div>

      {/* Top crash groups */}
      {summary.top_groups && summary.top_groups.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <div style={s.chartTitle}>Top Issues</div>
          {summary.top_groups.map((g, i) => (
            <div key={i} style={s.topGroupCard}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', color: '#e7e9ea', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.title}</div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <CrashTypeBadge type={g.crash_type || g.category} />
                <SeverityBadge severity={g.severity} />
                <span style={{ fontSize: '14px', fontWeight: '700', color: '#e7e9ea', minWidth: '24px', textAlign: 'right' }}>{g.count}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={s.chartsGrid}>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes (Last 30 Days)</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={summary.crashes_per_day}>
              <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/><stop offset="95%" stopColor="#ef4444" stopOpacity={0}/></linearGradient></defs>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71767b' }} tickFormatter={v => v.slice(5)} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="count" stroke="#ef4444" fill="url(#cg)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>By Crash Type</div>
          {summary.crash_type_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={summary.crash_type_breakdown} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={70}
                  label={({ name, count }) => `${name} (${count})`} labelLine={{ stroke: '#71767b' }} fontSize={10}>
                  {summary.crash_type_breakdown.map((e, i) => <Cell key={e.name} fill={CRASH_TYPE_COLORS[e.name] || PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>Time in Session at Crash</div>
          {summary.time_distribution?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.time_distribution}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#71767b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>

        <div style={s.chartCard}>
          <div style={s.chartTitle}>By GPU</div>
          {summary.gpu_breakdown?.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.gpu_breakdown.slice(0, 8)} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={150} tickFormatter={v => v.length > 24 ? v.slice(0, 24) + '...' : v} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No data</div>}
        </div>
      </div>
    </div>
  )
}

// ============================================
// GROUPS
// ============================================
function CrashGroupsView({ groups, loading, crashes }) {
  const [expandedId, setExpandedId] = useState(null)
  const [groupCrashes, setGroupCrashes] = useState({})
  const [loadingGroup, setLoadingGroup] = useState(null)

  const toggleGroup = async (groupId) => {
    if (expandedId === groupId) { setExpandedId(null); return }
    setExpandedId(groupId)
    if (!groupCrashes[groupId]) {
      setLoadingGroup(groupId)
      try {
        const data = await getCrashGroup(groupId)
        setGroupCrashes(prev => ({ ...prev, [groupId]: data.crashes }))
      } catch (err) { console.error(err) }
      finally { setLoadingGroup(null) }
    }
  }

  const getHardwareBreakdown = (crashList) => {
    if (!crashList) return null
    const gpus = {}, rams = {}, oss = {}
    crashList.forEach(c => {
      const ctx = c.crash_context || {}
      const gpu = ctx.gpu || c.gpu || 'unknown'
      const ram = ctx.ram_gb ? ctx.ram_gb + ' GB' : 'unknown'
      const os = ctx.os ? (ctx.os.includes('Windows 11') ? 'Win 11' : ctx.os.includes('Windows 10') ? 'Win 10' : 'Other') : 'unknown'
      gpus[gpu] = (gpus[gpu] || 0) + 1
      rams[ram] = (rams[ram] || 0) + 1
      oss[os] = (oss[os] || 0) + 1
    })
    return { gpus, rams, oss }
  }

  if (loading) return <div style={s.loading}>Loading...</div>
  if (!groups || groups.length === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No crash groups yet</div></div>

  return (
    <div>
      <div style={{ fontSize: '13px', color: '#71767b', marginBottom: '16px' }}>
        {groups.length} unique issue{groups.length !== 1 ? 's' : ''} from {crashes.length} crash{crashes.length !== 1 ? 'es' : ''}
      </div>
      {groups.map(group => {
        const hw = groupCrashes[group.id] ? getHardwareBreakdown(groupCrashes[group.id]) : null
        return (
          <div key={group.id} style={s.groupCard}>
            <div style={{ ...s.groupHeader, ...(expandedId === group.id ? { background: '#1a1d21' } : {}) }} onClick={() => toggleGroup(group.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                  <CrashTypeBadge type={group.crash_type || group.category} />
                  <SeverityBadge severity={group.severity} />
                </div>
                <div style={s.groupTitle}>{group.title}</div>
                {group.affected_gpus?.length > 0 && (
                  <div style={{ fontSize: '12px', color: '#71767b', marginTop: '4px' }}>GPUs: {group.affected_gpus.join(', ')}</div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <div style={s.countBadge}>{group.count}</div>
                <span style={{ fontSize: '11px', color: '#71767b', transform: expandedId === group.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
              </div>
            </div>
            {expandedId === group.id && (
              <div style={s.groupDetail}>
                {group.error_message && (
                  <div><div style={s.detailLabel}>Error Message</div>
                    <div style={{ ...s.detailText, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{group.error_message}</div>
                  </div>
                )}
                {(group.ai_root_cause || group.ai_suggested_fix) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                    {group.ai_root_cause && <div><div style={s.detailLabel}>AI Root Cause</div><div style={s.detailText}>{group.ai_root_cause}</div></div>}
                    {group.ai_suggested_fix && <div><div style={s.detailLabel}>Suggested Fix</div><div style={s.detailText}>{group.ai_suggested_fix}</div></div>}
                  </div>
                )}
                {hw && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                    <div><div style={s.detailLabel}>GPU Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.gpus).sort((a,b) => b[1]-a[1]).map(([gpu, cnt]) => <span key={gpu} style={{ ...s.tag, background: '#059669', color: '#fff' }}>{gpu} ({cnt})</span>)}
                    </div></div>
                    <div><div style={s.detailLabel}>RAM Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.rams).sort((a,b) => b[1]-a[1]).map(([ram, cnt]) => <span key={ram} style={{ ...s.tag, background: '#3b82f6', color: '#fff' }}>{ram} ({cnt})</span>)}
                    </div></div>
                    <div><div style={s.detailLabel}>OS Distribution</div><div style={s.tagList}>
                      {Object.entries(hw.oss).sort((a,b) => b[1]-a[1]).map(([os, cnt]) => <span key={os} style={{ ...s.tag, background: '#6366f1', color: '#fff' }}>{os} ({cnt})</span>)}
                    </div></div>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div><div style={s.detailLabel}>Affected Versions</div><div style={s.tagList}>
                    {(group.affected_versions || []).map(v => <span key={v} style={s.tag}>{v}</span>)}
                    {(!group.affected_versions || group.affected_versions.length === 0) && <span style={{ fontSize: '12px', color: '#71767b' }}>-</span>}
                  </div></div>
                  <div><div style={s.detailLabel}>Time Range</div>
                    <div style={{ fontSize: '12px', color: '#e7e9ea' }}>{group.first_seen ? `${formatShortDate(group.first_seen)} — ${formatShortDate(group.last_seen)}` : '-'}</div>
                  </div>
                </div>
                <div><div style={s.detailLabel}>Crashes ({group.count})</div>
                  {loadingGroup === group.id ? <div style={{ color: '#71767b', fontSize: '12px' }}>Loading...</div> :
                    groupCrashes[group.id] ? (
                      <table style={s.miniTable}><thead><tr>
                        <th style={s.miniTh}>Date</th><th style={s.miniTh}>GPU</th><th style={s.miniTh}>CPU</th>
                        <th style={s.miniTh}>RAM</th><th style={s.miniTh}>OS</th><th style={s.miniTh}>Session</th>
                      </tr></thead><tbody>
                        {groupCrashes[group.id].map(c => (
                          <tr key={c.id}>
                            <td style={s.miniTd}>{formatShortDate(c.upload_date)}</td>
                            <td style={s.miniTd}>{c.crash_context?.gpu || c.gpu || '-'}</td>
                            <td style={s.miniTd}>{c.crash_context?.cpu || '-'}</td>
                            <td style={s.miniTd}>{c.crash_context?.ram_gb ? c.crash_context.ram_gb + ' GB' : '-'}</td>
                            <td style={s.miniTd}>{c.crash_context?.os ? c.crash_context.os.split('[')[0].trim() : '-'}</td>
                            <td style={s.miniTd}>{c.crash_context?.seconds_since_start != null ? (c.crash_context.seconds_since_start < 60 ? c.crash_context.seconds_since_start + 's' : Math.floor(c.crash_context.seconds_since_start / 60) + 'm') : '-'}</td>
                          </tr>
                        ))}
                      </tbody></table>
                    ) : null}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ============================================
// HARDWARE
// ============================================
function HardwareView({ summary, loading }) {
  if (loading) return <div style={s.loading}>Loading...</div>
  if (!summary || summary.total_crashes === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No data</div></div>

  const gpuCrossRef = summary.crash_type_by_gpu || {}
  const allTypes = [...new Set(Object.values(gpuCrossRef).flatMap(v => Object.keys(v)))]
  const gpuRows = Object.entries(gpuCrossRef)
    .map(([gpu, types]) => ({ gpu, total: Object.values(types).reduce((a, b) => a + b, 0), ...types }))
    .sort((a, b) => b.total - a.total)

  return (
    <div>
      <div style={s.chartsGrid}>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by GPU</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={summary.gpu_breakdown?.slice(0, 10)} layout="vertical">
              <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={160} tickFormatter={v => v.length > 26 ? v.slice(0, 26) + '...' : v} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by RAM</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={summary.ram_breakdown}>
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Out of Memory — by RAM</div>
          {summary.oom_by_ram?.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={summary.oom_by_ram}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No OOM crashes</div>}
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Out of Memory — by GPU</div>
          {summary.oom_by_gpu?.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={summary.oom_by_gpu.slice(0, 8)} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={160} tickFormatter={v => v.length > 26 ? v.slice(0, 26) + '...' : v} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="count" fill="#ef4444" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', padding: '20px 0' }}>No OOM crashes</div>}
        </div>
        <div style={s.chartCard}>
          <div style={s.chartTitle}>Crashes by OS</div>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={summary.os_breakdown} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={80}
                label={({ name, count }) => `${name} (${count})`} labelLine={{ stroke: '#71767b' }} fontSize={11}>
                {(summary.os_breakdown || []).map((e, i) => <Cell key={e.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={s.card}>
        <div style={s.chartTitle}>Crash Type by GPU</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}><thead><tr>
            <th style={s.th}>GPU</th><th style={{ ...s.th, textAlign: 'right' }}>Total</th>
            {allTypes.map(t => <th key={t} style={{ ...s.th, textAlign: 'right' }}>{t}</th>)}
          </tr></thead><tbody>
            {gpuRows.map(row => (
              <tr key={row.gpu}>
                <td style={s.td}>{row.gpu}</td>
                <td style={{ ...s.td, textAlign: 'right', fontWeight: '600' }}>{row.total}</td>
                {allTypes.map(t => (
                  <td key={t} style={{ ...s.td, textAlign: 'right', color: row[t] ? CRASH_TYPE_COLORS[t] || '#e7e9ea' : '#2f3336' }}>{row[t] || '-'}</td>
                ))}
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>
    </div>
  )
}

// ============================================
// ALL REPORTS
// ============================================
function AllReports({ crashes, loading, onRefresh, onDelete }) {
  const [expandedId, setExpandedId] = useState(null)
  const handleDownload = (crashId, filename) => {
    const adminKey = getAdminKey()
    fetch(`/api/crashes/${crashId}/download`, { headers: { 'x-admin-key': adminKey } })
      .then(r => r.blob()).then(blob => {
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url; a.download = filename
        document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url)
      }).catch(err => alert('Download failed: ' + err.message))
  }
  if (loading) return <div style={s.loading}>Loading...</div>
  if (crashes.length === 0) return <div style={s.emptyState}><div style={s.emptyTitle}>No crash reports</div></div>

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: '600', color: '#e7e9ea' }}>All Reports</div>
          <div style={{ fontSize: '13px', color: '#71767b', marginTop: '4px' }}>{crashes.length} reports — {formatFileSize(crashes.reduce((sum, c) => sum + (c.file_size || 0), 0))}</div>
        </div>
        <button style={s.refreshBtn} onClick={onRefresh}>Refresh</button>
      </div>
      <table style={s.table}><thead><tr>
        <th style={s.th}>Date</th><th style={s.th}>Type</th><th style={s.th}>GPU</th>
        <th style={s.th}>RAM</th><th style={s.th}>Session</th><th style={s.th}>Actions</th>
      </tr></thead><tbody>
        {crashes.map(crash => {
          const ctx = crash.crash_context || {}
          return (
            <React.Fragment key={crash.id}>
              <tr style={expandedId === crash.id ? s.expandedRow : s.clickableRow}
                onClick={() => setExpandedId(expandedId === crash.id ? null : crash.id)}>
                <td style={s.td}>{formatDate(crash.upload_date)}</td>
                <td style={s.td}><CrashTypeBadge type={ctx.crash_type || crash.crash_type || 'Unknown'} /></td>
                <td style={s.td}><span style={{ fontSize: '12px' }}>{ctx.gpu || crash.gpu || '-'}</span></td>
                <td style={s.td}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</td>
                <td style={s.td}>{ctx.seconds_since_start != null ? (ctx.seconds_since_start < 60 ? ctx.seconds_since_start + 's' : Math.floor(ctx.seconds_since_start / 60) + 'm') : '-'}</td>
                <td style={s.td} onClick={e => e.stopPropagation()}>
                  <button style={s.actionBtn} onClick={() => handleDownload(crash.id, crash.filename)}>Download</button>
                  <button style={s.deleteBtn} onClick={() => { if (confirm('Delete?')) onDelete(crash.id) }}>Delete</button>
                </td>
              </tr>
              {expandedId === crash.id && (
                <tr><td colSpan="6" style={s.detailsCell}><div style={s.detailsGrid}>
                  {(ctx.error_message || crash.error_message) && (
                    <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                      <div style={s.detailItemLabel}>Error Message</div>
                      <div style={{ ...s.detailItemValue, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>{ctx.error_message || crash.error_message}</div>
                    </div>
                  )}
                  <div style={s.detailItem}><div style={s.detailItemLabel}>GPU</div><div style={s.detailItemValue}>{ctx.gpu || crash.gpu || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>CPU</div><div style={s.detailItemValue}>{ctx.cpu || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>OS</div><div style={s.detailItemValue}>{ctx.os || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>RAM</div><div style={s.detailItemValue}>{ctx.ram_gb ? ctx.ram_gb + ' GB' : '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>RHI</div><div style={s.detailItemValue}>{crash.rhi || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Build ID</div><div style={s.detailItemValue}>{crash.build_id || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Callstack Hash</div><div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px' }}>{ctx.callstack_hash || '-'}</div></div>
                  <div style={s.detailItem}><div style={s.detailItemLabel}>Version</div><div style={s.detailItemValue}>{crash.version || '-'}</div></div>
                  {ctx.callstack && (
                    <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                      <div style={s.detailItemLabel}>Callstack</div>
                      <div style={{ ...s.detailItemValue, fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' }}>{ctx.callstack}</div>
                    </div>
                  )}
                </div></td></tr>
              )}
            </React.Fragment>
          )
        })}
      </tbody></table>
    </div>
  )
}

// ============================================
// MAIN
// ============================================
function CrashReports() {
  const [tab, setTab] = useState('overview')
  const [crashes, setCrashes] = useState([])
  const [groups, setGroups] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)
  const [error, setError] = useState(null)

  const fetchAll = async () => {
    try {
      setLoading(true); setError(null)
      const [cd, gd, sd] = await Promise.all([
        getCrashes(), getCrashGroups().catch(() => ({ groups: [] })), getCrashSummary().catch(() => null)
      ])
      setCrashes(cd.crashes || []); setGroups(gd.groups || []); setSummary(sd)
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { fetchAll() }, [])

  const handleReclassify = async () => {
    if (!confirm('Re-extract and re-categorize all crash reports?')) return
    try { setReclassifying(true); setError(null); await reclassifyCrashes(); await fetchAll() }
    catch (err) { setError('Reclassification failed: ' + err.message) }
    finally { setReclassifying(false) }
  }

  const handleDelete = async (crashId) => {
    await deleteCrash(crashId)
    setCrashes(crashes.filter(c => c.id !== crashId))
    getCrashSummary().then(setSummary).catch(() => {})
  }

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'groups', label: 'Groups', count: groups.length },
    { id: 'hardware', label: 'Hardware' },
    { id: 'reports', label: 'All Reports', count: crashes.length }
  ]

  return (
    <div style={s.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={s.subTabs}>
          {tabs.map(t => (
            <button key={t.id} style={{ ...s.subTab, ...(tab === t.id ? s.subTabActive : {}) }} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count > 0 && <span style={{ marginLeft: '6px', background: tab === t.id ? 'rgba(255,255,255,0.2)' : '#2f3336', padding: '1px 6px', borderRadius: '10px', fontSize: '11px' }}>{t.count}</span>}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={s.refreshBtn} onClick={fetchAll}>Refresh</button>
          <button style={{ ...s.refreshBtn, ...(reclassifying ? { opacity: 0.5 } : {}) }} onClick={handleReclassify} disabled={reclassifying}>
            {reclassifying ? 'Processing...' : 'Reclassify All'}
          </button>
        </div>
      </div>
      {error && <div style={s.error}>{error}</div>}
      {tab === 'overview' && <CrashOverview summary={summary} loading={loading} />}
      {tab === 'groups' && <CrashGroupsView groups={groups} loading={loading} crashes={crashes} />}
      {tab === 'hardware' && <HardwareView summary={summary} loading={loading} />}
      {tab === 'reports' && <AllReports crashes={crashes} loading={loading} onRefresh={fetchAll} onDelete={handleDelete} />}
    </div>
  )
}

export default CrashReports
