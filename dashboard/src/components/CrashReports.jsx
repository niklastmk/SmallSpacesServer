import React, { useState, useEffect } from 'react'
import { getCrashes, deleteCrash, getAdminKey, reclassifyCrashes, getCrashGroups, getCrashGroup, getCrashSummary } from '../api'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area, Cell, PieChart, Pie } from 'recharts'

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px'
  },
  card: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '16px'
  },
  title: {
    fontSize: '18px',
    fontWeight: '600',
    color: '#e7e9ea'
  },
  subtitle: {
    fontSize: '13px',
    color: '#71767b',
    marginTop: '4px'
  },
  subTabs: {
    display: 'flex',
    gap: '4px',
    background: '#16181c',
    borderRadius: '10px',
    padding: '4px',
    border: '1px solid #2f3336'
  },
  subTab: {
    background: 'transparent',
    border: 'none',
    color: '#71767b',
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '500',
    borderRadius: '8px',
    transition: 'all 0.15s'
  },
  subTabActive: {
    background: '#1d9bf0',
    color: '#fff'
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: '12px',
    marginBottom: '20px'
  },
  statCard: {
    background: '#1a1d21',
    borderRadius: '10px',
    padding: '16px',
    border: '1px solid #2f3336'
  },
  statValue: {
    fontSize: '28px',
    fontWeight: '700',
    color: '#e7e9ea'
  },
  statLabel: {
    fontSize: '12px',
    color: '#71767b',
    marginTop: '4px',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  chartsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))',
    gap: '16px',
    marginBottom: '20px'
  },
  chartCard: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  chartTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: '#e7e9ea',
    marginBottom: '16px'
  },
  reclassifyBtn: {
    background: '#2f3336',
    border: 'none',
    color: '#e7e9ea',
    padding: '6px 14px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: '500'
  },
  reclassifyBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed'
  },
  refreshBtn: {
    background: '#2f3336',
    border: 'none',
    color: '#e7e9ea',
    padding: '6px 12px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px'
  },
  groupCard: {
    background: '#16181c',
    borderRadius: '12px',
    border: '1px solid #2f3336',
    overflow: 'hidden',
    marginBottom: '12px'
  },
  groupHeader: {
    padding: '16px 20px',
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '16px'
  },
  groupTitle: {
    fontSize: '15px',
    fontWeight: '600',
    color: '#e7e9ea',
    marginBottom: '4px'
  },
  groupDesc: {
    fontSize: '13px',
    color: '#71767b',
    lineHeight: '1.4'
  },
  groupMeta: {
    display: 'flex',
    gap: '8px',
    flexShrink: 0,
    alignItems: 'center'
  },
  groupDetail: {
    padding: '0 20px 20px',
    borderTop: '1px solid #2f3336'
  },
  detailSection: {
    marginTop: '16px'
  },
  detailLabel: {
    fontSize: '11px',
    color: '#71767b',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '6px'
  },
  detailText: {
    fontSize: '13px',
    color: '#e7e9ea',
    lineHeight: '1.5',
    background: '#1a1d21',
    padding: '10px 14px',
    borderRadius: '8px'
  },
  tagList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px'
  },
  tag: {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: '500',
    background: '#2f3336',
    color: '#e7e9ea'
  },
  severityCritical: { background: '#dc2626', color: '#fff' },
  severityHigh: { background: '#ea580c', color: '#fff' },
  severityMedium: { background: '#d97706', color: '#fff' },
  severityLow: { background: '#2563eb', color: '#fff' },
  categoryBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '10px',
    fontWeight: '600',
    letterSpacing: '0.5px'
  },
  countBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '28px',
    height: '28px',
    borderRadius: '14px',
    fontSize: '13px',
    fontWeight: '700',
    background: '#2f3336',
    color: '#e7e9ea'
  },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: {
    textAlign: 'left',
    padding: '12px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#71767b',
    fontSize: '12px',
    fontWeight: '500',
    textTransform: 'uppercase',
    letterSpacing: '0.5px'
  },
  td: {
    padding: '12px 8px',
    borderBottom: '1px solid #2f3336',
    color: '#e7e9ea',
    fontSize: '13px',
    verticalAlign: 'top'
  },
  clickableRow: { cursor: 'pointer' },
  expandedRow: { background: '#1a1d21' },
  detailsCell: { padding: '16px', background: '#1a1d21' },
  detailsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: '12px'
  },
  detailItem: {
    background: '#2f3336',
    padding: '8px 12px',
    borderRadius: '6px'
  },
  detailItemLabel: {
    fontSize: '11px',
    color: '#71767b',
    marginBottom: '2px'
  },
  detailItemValue: {
    fontSize: '13px',
    color: '#e7e9ea',
    wordBreak: 'break-all'
  },
  badge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: '500'
  },
  platformBadge: { background: '#2f3336', color: '#e7e9ea' },
  sizeBadge: { background: '#1d4ed8', color: '#fff' },
  gpuBadge: { background: '#059669', color: '#fff' },
  actionBtn: {
    background: '#1d9bf0',
    border: 'none',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    marginRight: '6px'
  },
  deleteBtn: {
    background: '#dc3545',
    border: 'none',
    color: '#fff',
    padding: '4px 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px'
  },
  emptyState: {
    textAlign: 'center',
    padding: '48px 24px',
    color: '#71767b'
  },
  emptyTitle: {
    fontSize: '16px',
    fontWeight: '600',
    color: '#e7e9ea',
    marginBottom: '8px'
  },
  loading: {
    textAlign: 'center',
    padding: '40px',
    color: '#71767b'
  },
  error: {
    background: '#67000d',
    color: '#ff6b6b',
    padding: '12px',
    borderRadius: '6px',
    marginBottom: '16px',
    fontSize: '13px'
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    background: '#1a1d21',
    borderRadius: '8px',
    fontSize: '13px',
    color: '#71767b',
    marginBottom: '16px'
  },
  dot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0
  },
  miniTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '12px'
  },
  miniTh: {
    textAlign: 'left',
    padding: '8px 6px',
    borderBottom: '1px solid #2f3336',
    color: '#71767b',
    fontSize: '11px',
    fontWeight: '500'
  },
  miniTd: {
    padding: '8px 6px',
    borderBottom: '1px solid #2f3336',
    color: '#e7e9ea',
    fontSize: '12px'
  }
}

const SEVERITY_STYLES = {
  critical: styles.severityCritical,
  high: styles.severityHigh,
  medium: styles.severityMedium,
  low: styles.severityLow
}

const CATEGORY_COLORS = {
  GPU_DRIVER: '#8b5cf6',
  OUT_OF_MEMORY: '#ef4444',
  SHADER: '#f59e0b',
  ACCESS_VIOLATION: '#dc2626',
  HANG_TIMEOUT: '#ea580c',
  RENDERING: '#3b82f6',
  ASSET_LOADING: '#10b981',
  AUDIO: '#a78bfa',
  PHYSICS: '#f472b6',
  NETWORKING: '#38bdf8',
  PLUGIN: '#6366f1',
  ENGINE: '#ec4899',
  SAVE_SYSTEM: '#14b8a6',
  UI: '#fbbf24',
  OTHER: '#6b7280',
  UNANALYZED: '#374151'
}

const PIE_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#14b8a6', '#ea580c', '#6b7280']

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString()
}

function formatShortDate(dateString) {
  return new Date(dateString).toLocaleDateString()
}

function SeverityBadge({ severity }) {
  return (
    <span style={{ ...styles.badge, ...(SEVERITY_STYLES[severity] || styles.platformBadge) }}>
      {severity}
    </span>
  )
}

function CategoryBadge({ category }) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.OTHER
  return (
    <span style={{ ...styles.categoryBadge, background: color + '22', color }}>
      {(category || 'unknown').replace(/_/g, ' ')}
    </span>
  )
}

// ============================================
// OVERVIEW SUB-TAB
// ============================================
function CrashOverview({ summary, loading }) {
  if (loading) return <div style={styles.loading}>Loading crash summary...</div>

  if (!summary || summary.total_crashes === 0) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyTitle}>No crash reports yet</div>
        <div>Crash reports will appear here automatically when players experience issues.</div>
      </div>
    )
  }

  return (
    <div>
      {/* Stats Cards */}
      <div style={styles.statsGrid}>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{summary.total_crashes}</div>
          <div style={styles.statLabel}>Total Crashes</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{summary.crashes_today}</div>
          <div style={styles.statLabel}>Today</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{summary.crashes_this_week}</div>
          <div style={styles.statLabel}>This Week</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{summary.total_groups}</div>
          <div style={styles.statLabel}>Issue Groups</div>
        </div>
        <div style={styles.statCard}>
          <div style={styles.statValue}>{summary.classified_count}</div>
          <div style={styles.statLabel}>Classified</div>
        </div>
      </div>

      {/* AI status */}
      <div style={styles.statusBar}>
        <div style={{ ...styles.dot, background: summary.ai_enabled ? '#10b981' : '#ef4444' }} />
        {summary.ai_enabled
          ? `Auto-classification active — ${summary.classified_count}/${summary.total_crashes} classified`
          : 'AI classification disabled (ANTHROPIC_API_KEY not set on server)'
        }
        {summary.unclassified_count > 0 && summary.ai_enabled && (
          <span style={{ color: '#f59e0b', marginLeft: '4px' }}>
            ({summary.unclassified_count} pending)
          </span>
        )}
      </div>

      {/* Top issue */}
      {summary.top_group && (
        <div style={{ ...styles.card, marginBottom: '20px', borderLeft: '3px solid #ef4444' }}>
          <div style={{ fontSize: '12px', color: '#71767b', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Most Common Issue
          </div>
          <div style={{ fontSize: '15px', fontWeight: '600', color: '#e7e9ea', marginBottom: '4px' }}>
            {summary.top_group.title}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <SeverityBadge severity={summary.top_group.severity} />
            <span style={{ fontSize: '13px', color: '#71767b' }}>
              {summary.top_group.count} crash{summary.top_group.count !== 1 ? 'es' : ''}
            </span>
          </div>
        </div>
      )}

      {/* Charts */}
      <div style={styles.chartsGrid}>
        {/* Crashes over time */}
        <div style={styles.chartCard}>
          <div style={styles.chartTitle}>Crashes (Last 30 Days)</div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={summary.crashes_per_day}>
              <defs>
                <linearGradient id="crashGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#71767b' }} tickFormatter={v => v.slice(5)} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }} labelStyle={{ color: '#71767b' }} itemStyle={{ color: '#ef4444' }} />
              <Area type="monotone" dataKey="count" stroke="#ef4444" fill="url(#crashGradient)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* By GPU */}
        <div style={styles.chartCard}>
          <div style={styles.chartTitle}>By GPU</div>
          {summary.gpu_breakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.gpu_breakdown.slice(0, 8)} layout="vertical">
                <XAxis type="number" tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} width={140} tickFormatter={v => v.length > 22 ? v.slice(0, 22) + '...' : v} />
                <Tooltip contentStyle={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }} labelStyle={{ color: '#71767b' }} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', fontSize: '13px', padding: '20px 0' }}>No data</div>}
        </div>

        {/* By Version */}
        <div style={styles.chartCard}>
          <div style={styles.chartTitle}>By Version</div>
          {summary.version_breakdown.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={summary.version_breakdown.slice(0, 8)}>
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#71767b' }} />
                <YAxis tick={{ fontSize: 10, fill: '#71767b' }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }} labelStyle={{ color: '#71767b' }} />
                <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <div style={{ color: '#71767b', fontSize: '13px', padding: '20px 0' }}>No data</div>}
        </div>

        {/* By Category */}
        <div style={styles.chartCard}>
          <div style={styles.chartTitle}>By Category</div>
          {summary.category_breakdown.length > 0 && !(summary.category_breakdown.length === 1 && summary.category_breakdown[0].name === 'UNANALYZED') ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={summary.category_breakdown.filter(c => c.name !== 'UNANALYZED')}
                  dataKey="count"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  label={({ name, count }) => `${name.replace(/_/g, ' ')} (${count})`}
                  labelLine={{ stroke: '#71767b' }}
                  fontSize={10}
                >
                  {summary.category_breakdown.filter(c => c.name !== 'UNANALYZED').map((entry, index) => (
                    <Cell key={entry.name} fill={CATEGORY_COLORS[entry.name] || PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: '#1a1d21', border: '1px solid #2f3336', borderRadius: '8px', fontSize: '12px' }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ color: '#71767b', fontSize: '13px', padding: '20px 0' }}>
              Waiting for classified crashes
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================
// GROUPS SUB-TAB
// ============================================
function CrashGroupsView({ groups, loading, crashes }) {
  const [expandedGroupId, setExpandedGroupId] = useState(null)
  const [groupCrashes, setGroupCrashes] = useState({})
  const [loadingGroup, setLoadingGroup] = useState(null)

  const toggleGroup = async (groupId) => {
    if (expandedGroupId === groupId) {
      setExpandedGroupId(null)
      return
    }
    setExpandedGroupId(groupId)

    if (!groupCrashes[groupId]) {
      setLoadingGroup(groupId)
      try {
        const data = await getCrashGroup(groupId)
        setGroupCrashes(prev => ({ ...prev, [groupId]: data.crashes }))
      } catch (err) {
        console.error('Failed to load group crashes:', err)
      } finally {
        setLoadingGroup(null)
      }
    }
  }

  if (loading) return <div style={styles.loading}>Loading crash groups...</div>

  if (!groups || groups.length === 0) {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyTitle}>No crash groups yet</div>
        <div>Crashes are automatically grouped as they are reported and classified.</div>
      </div>
    )
  }

  return (
    <div>
      <div style={styles.statusBar}>
        {groups.length} issue group{groups.length !== 1 ? 's' : ''} from {crashes.length} crash report{crashes.length !== 1 ? 's' : ''}
      </div>

      {groups.map(group => (
        <div key={group.id} style={styles.groupCard}>
          <div
            style={{ ...styles.groupHeader, ...(expandedGroupId === group.id ? { background: '#1a1d21' } : {}) }}
            onClick={() => toggleGroup(group.id)}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
                <span style={styles.groupTitle}>{group.title}</span>
                <SeverityBadge severity={group.severity} />
                <CategoryBadge category={group.category} />
              </div>
              <div style={styles.groupDesc}>{group.description}</div>
            </div>
            <div style={styles.groupMeta}>
              <div style={styles.countBadge}>{group.count}</div>
              <span style={{ fontSize: '11px', color: '#71767b', transform: expandedGroupId === group.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                ▼
              </span>
            </div>
          </div>

          {expandedGroupId === group.id && (
            <div style={styles.groupDetail}>
              {/* Error message */}
              {group.error_message && (
                <div style={{ ...styles.detailSection, marginTop: '12px' }}>
                  <div style={styles.detailLabel}>Error Message</div>
                  <div style={{ ...styles.detailText, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                    {group.error_message}
                  </div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                {group.root_cause && (
                  <div style={styles.detailSection}>
                    <div style={styles.detailLabel}>AI Root Cause</div>
                    <div style={styles.detailText}>{group.root_cause}</div>
                  </div>
                )}
                {group.suggested_fix && (
                  <div style={styles.detailSection}>
                    <div style={styles.detailLabel}>Suggested Fix</div>
                    <div style={styles.detailText}>{group.suggested_fix}</div>
                  </div>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginTop: '16px' }}>
                <div>
                  <div style={styles.detailLabel}>Affected GPUs</div>
                  <div style={styles.tagList}>
                    {(group.affected_gpus || []).map(gpu => (
                      <span key={gpu} style={{ ...styles.tag, background: '#059669', color: '#fff' }}>{gpu}</span>
                    ))}
                    {(!group.affected_gpus || group.affected_gpus.length === 0) && <span style={{ fontSize: '12px', color: '#71767b' }}>-</span>}
                  </div>
                </div>
                <div>
                  <div style={styles.detailLabel}>Affected Versions</div>
                  <div style={styles.tagList}>
                    {(group.affected_versions || []).map(v => (
                      <span key={v} style={{ ...styles.tag, background: '#3b82f6', color: '#fff' }}>{v}</span>
                    ))}
                    {(!group.affected_versions || group.affected_versions.length === 0) && <span style={{ fontSize: '12px', color: '#71767b' }}>-</span>}
                  </div>
                </div>
                <div>
                  <div style={styles.detailLabel}>Time Range</div>
                  <div style={{ fontSize: '12px', color: '#e7e9ea' }}>
                    {group.first_seen ? `${formatShortDate(group.first_seen)} — ${formatShortDate(group.last_seen)}` : '-'}
                  </div>
                </div>
              </div>

              {/* Crashes in group */}
              <div style={{ marginTop: '16px' }}>
                <div style={styles.detailLabel}>Crashes in this group ({group.count})</div>
                {loadingGroup === group.id ? (
                  <div style={{ color: '#71767b', fontSize: '12px', padding: '8px 0' }}>Loading...</div>
                ) : groupCrashes[group.id] ? (
                  <table style={styles.miniTable}>
                    <thead>
                      <tr>
                        <th style={styles.miniTh}>Date</th>
                        <th style={styles.miniTh}>GPU</th>
                        <th style={styles.miniTh}>CPU</th>
                        <th style={styles.miniTh}>RAM</th>
                        <th style={styles.miniTh}>OS</th>
                        <th style={styles.miniTh}>Time in Session</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupCrashes[group.id].map(crash => (
                        <tr key={crash.id}>
                          <td style={styles.miniTd}>{formatShortDate(crash.upload_date)}</td>
                          <td style={styles.miniTd}>{crash.crash_context?.gpu || crash.gpu || '-'}</td>
                          <td style={styles.miniTd}>{crash.crash_context?.cpu || '-'}</td>
                          <td style={styles.miniTd}>{crash.crash_context?.ram_gb ? crash.crash_context.ram_gb + ' GB' : '-'}</td>
                          <td style={styles.miniTd}>{crash.crash_context?.os ? crash.crash_context.os.split('[')[0].trim() : '-'}</td>
                          <td style={styles.miniTd}>
                            {crash.crash_context?.seconds_since_start != null
                              ? crash.crash_context.seconds_since_start < 60
                                ? crash.crash_context.seconds_since_start + 's'
                                : Math.floor(crash.crash_context.seconds_since_start / 60) + 'm'
                              : '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================
// ALL REPORTS SUB-TAB
// ============================================
function AllReports({ crashes, loading, onRefresh, onDelete }) {
  const [expandedId, setExpandedId] = useState(null)

  const handleDownload = (crashId, filename) => {
    const adminKey = getAdminKey()
    fetch(`/api/crashes/${crashId}/download`, { headers: { 'x-admin-key': adminKey } })
      .then(r => r.blob())
      .then(blob => {
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.URL.revokeObjectURL(url)
      })
      .catch(err => alert('Download failed: ' + err.message))
  }

  const handleDelete = async (crashId) => {
    if (!confirm('Delete this crash report?')) return
    try { await onDelete(crashId) } catch (err) { alert('Delete failed: ' + err.message) }
  }

  if (loading) return <div style={styles.loading}>Loading crash reports...</div>

  if (crashes.length === 0) {
    return <div style={styles.emptyState}><div style={styles.emptyTitle}>No crash reports</div></div>
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h3 style={styles.title}>All Reports</h3>
          <div style={styles.subtitle}>
            {crashes.length} report{crashes.length !== 1 ? 's' : ''} — {formatFileSize(crashes.reduce((sum, c) => sum + (c.file_size || 0), 0))} total
          </div>
        </div>
        <button style={styles.refreshBtn} onClick={onRefresh}>Refresh</button>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Date</th>
            <th style={styles.th}>Category</th>
            <th style={styles.th}>Version</th>
            <th style={styles.th}>Platform</th>
            <th style={styles.th}>GPU</th>
            <th style={styles.th}>Size</th>
            <th style={styles.th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {crashes.map(crash => (
            <React.Fragment key={crash.id}>
              <tr
                style={expandedId === crash.id ? styles.expandedRow : styles.clickableRow}
                onClick={() => setExpandedId(expandedId === crash.id ? null : crash.id)}
              >
                <td style={styles.td}>{formatDate(crash.upload_date)}</td>
                <td style={styles.td}>
                  {crash.ai_analysis ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <CategoryBadge category={crash.ai_analysis.category} />
                      <SeverityBadge severity={crash.ai_analysis.severity} />
                    </div>
                  ) : (
                    <span style={{ ...styles.badge, background: '#374151', color: '#9ca3af' }}>pending</span>
                  )}
                </td>
                <td style={styles.td}>
                  <span style={{ ...styles.badge, ...styles.platformBadge }}>{crash.version || 'unknown'}</span>
                </td>
                <td style={styles.td}>
                  <span style={{ ...styles.badge, ...styles.platformBadge }}>{crash.platform}</span>
                </td>
                <td style={styles.td}>
                  <span style={{ ...styles.badge, ...styles.gpuBadge }}>{crash.gpu || 'unknown'}</span>
                </td>
                <td style={styles.td}>
                  <span style={{ ...styles.badge, ...styles.sizeBadge }}>{formatFileSize(crash.file_size)}</span>
                </td>
                <td style={styles.td} onClick={e => e.stopPropagation()}>
                  <button style={styles.actionBtn} onClick={() => handleDownload(crash.id, crash.filename)}>Download</button>
                  <button style={styles.deleteBtn} onClick={() => handleDelete(crash.id)}>Delete</button>
                </td>
              </tr>
              {expandedId === crash.id && (
                <tr>
                  <td colSpan="7" style={styles.detailsCell}>
                    <div style={styles.detailsGrid}>
                      {/* Error message - most important */}
                      {(crash.error_message || (crash.crash_context && crash.crash_context.error_message)) && (
                        <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                          <div style={styles.detailItemLabel}>Error Message</div>
                          <div style={{ ...styles.detailItemValue, color: '#ff6b6b', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                            {crash.crash_context?.error_message || crash.error_message}
                          </div>
                        </div>
                      )}
                      {/* AI analysis */}
                      {crash.ai_analysis && (
                        <>
                          <div style={{ ...styles.detailItem, gridColumn: '1 / -1', background: '#1d2939' }}>
                            <div style={styles.detailItemLabel}>AI Root Cause</div>
                            <div style={styles.detailItemValue}>{crash.ai_analysis.root_cause}</div>
                          </div>
                          {crash.ai_analysis.suggested_fix && (
                            <div style={{ ...styles.detailItem, gridColumn: '1 / -1', background: '#1d2939' }}>
                              <div style={styles.detailItemLabel}>Suggested Fix</div>
                              <div style={styles.detailItemValue}>{crash.ai_analysis.suggested_fix}</div>
                            </div>
                          )}
                        </>
                      )}
                      {/* Hardware & system info */}
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>Crash Type</div>
                        <div style={styles.detailItemValue}>{crash.crash_context?.crash_type || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>GPU</div>
                        <div style={styles.detailItemValue}>{crash.crash_context?.gpu || crash.gpu || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>CPU</div>
                        <div style={styles.detailItemValue}>{crash.crash_context?.cpu || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>OS</div>
                        <div style={styles.detailItemValue}>{crash.crash_context?.os || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>RAM</div>
                        <div style={styles.detailItemValue}>{crash.crash_context?.ram_gb ? crash.crash_context.ram_gb + ' GB' : '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>RHI</div>
                        <div style={styles.detailItemValue}>{crash.rhi || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>Time in Session</div>
                        <div style={styles.detailItemValue}>
                          {crash.crash_context?.seconds_since_start != null
                            ? crash.crash_context.seconds_since_start < 60
                              ? crash.crash_context.seconds_since_start + 's'
                              : Math.floor(crash.crash_context.seconds_since_start / 60) + 'm ' + (crash.crash_context.seconds_since_start % 60) + 's'
                            : '-'}
                        </div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>Build ID</div>
                        <div style={styles.detailItemValue}>{crash.build_id || '-'}</div>
                      </div>
                      <div style={styles.detailItem}>
                        <div style={styles.detailItemLabel}>Callstack Hash</div>
                        <div style={{ ...styles.detailItemValue, fontFamily: 'monospace', fontSize: '11px' }}>
                          {crash.crash_context?.callstack_hash || '-'}
                        </div>
                      </div>
                      {/* Callstack */}
                      {crash.crash_context?.callstack && (
                        <div style={{ ...styles.detailItem, gridColumn: '1 / -1' }}>
                          <div style={styles.detailItemLabel}>Callstack</div>
                          <div style={{ ...styles.detailItemValue, fontFamily: 'monospace', fontSize: '11px', whiteSpace: 'pre-wrap', maxHeight: '200px', overflow: 'auto' }}>
                            {crash.crash_context.callstack}
                          </div>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ============================================
// MAIN CRASH REPORTS COMPONENT
// ============================================
function CrashReports() {
  const [activeSubTab, setActiveSubTab] = useState('overview')
  const [crashes, setCrashes] = useState([])
  const [groups, setGroups] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [reclassifying, setReclassifying] = useState(false)
  const [error, setError] = useState(null)

  const fetchAll = async () => {
    try {
      setLoading(true)
      setError(null)
      const [crashData, groupData, summaryData] = await Promise.all([
        getCrashes(),
        getCrashGroups().catch(() => ({ groups: [] })),
        getCrashSummary().catch(() => null)
      ])
      setCrashes(crashData.crashes || [])
      setGroups(groupData.groups || [])
      setSummary(summaryData)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAll() }, [])

  const handleReclassify = async () => {
    if (!confirm('This will clear all existing groups and re-classify every crash report. This may take a while and uses the AI API. Continue?')) return
    try {
      setReclassifying(true)
      setError(null)
      await reclassifyCrashes()
      await fetchAll()
    } catch (err) {
      setError('Reclassification failed: ' + err.message)
    } finally {
      setReclassifying(false)
    }
  }

  const handleDeleteCrash = async (crashId) => {
    await deleteCrash(crashId)
    setCrashes(crashes.filter(c => c.id !== crashId))
    getCrashSummary().then(setSummary).catch(() => {})
  }

  return (
    <div style={styles.container}>
      {/* Header with sub-tabs and reclassify */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={styles.subTabs}>
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'groups', label: 'Groups', count: groups.length },
            { id: 'reports', label: 'All Reports', count: crashes.length }
          ].map(tab => (
            <button
              key={tab.id}
              style={{ ...styles.subTab, ...(activeSubTab === tab.id ? styles.subTabActive : {}) }}
              onClick={() => setActiveSubTab(tab.id)}
            >
              {tab.label}
              {tab.count > 0 && (
                <span style={{
                  marginLeft: '6px',
                  background: activeSubTab === tab.id ? 'rgba(255,255,255,0.2)' : '#2f3336',
                  padding: '1px 6px',
                  borderRadius: '10px',
                  fontSize: '11px'
                }}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={styles.refreshBtn} onClick={fetchAll}>Refresh</button>
          <button
            style={{ ...styles.reclassifyBtn, ...(reclassifying ? styles.reclassifyBtnDisabled : {}) }}
            onClick={handleReclassify}
            disabled={reclassifying}
          >
            {reclassifying ? 'Reclassifying...' : 'Reclassify All'}
          </button>
        </div>
      </div>

      {error && (
        <div style={styles.error}>
          {error}
          <button
            onClick={fetchAll}
            style={{ marginLeft: '12px', padding: '2px 10px', cursor: 'pointer', background: 'transparent', border: '1px solid #ff6b6b', color: '#ff6b6b', borderRadius: '4px', fontSize: '12px' }}
          >
            Retry
          </button>
        </div>
      )}

      {activeSubTab === 'overview' && <CrashOverview summary={summary} loading={loading} />}
      {activeSubTab === 'groups' && <CrashGroupsView groups={groups} loading={loading} crashes={crashes} />}
      {activeSubTab === 'reports' && <AllReports crashes={crashes} loading={loading} onRefresh={fetchAll} onDelete={handleDeleteCrash} />}
    </div>
  )
}

export default CrashReports
