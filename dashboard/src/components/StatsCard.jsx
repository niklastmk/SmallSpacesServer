import React from 'react'

const styles = {
  card: {
    background: '#16181c',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2f3336'
  },
  title: {
    fontSize: '14px',
    color: '#71767b',
    marginBottom: '8px'
  },
  value: {
    fontSize: '32px',
    fontWeight: '700',
    color: '#e7e9ea'
  },
  subtitle: {
    fontSize: '13px',
    color: '#71767b',
    marginTop: '8px'
  }
}

function StatsCard({ title, value, subtitle }) {
  return (
    <div style={styles.card}>
      <div style={styles.title}>{title}</div>
      <div style={styles.value}>{value.toLocaleString()}</div>
      {subtitle && <div style={styles.subtitle}>{subtitle}</div>}
    </div>
  )
}

export default StatsCard
