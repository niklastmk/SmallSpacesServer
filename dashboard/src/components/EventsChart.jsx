import React from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const styles = {
  noData: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    height: '200px',
    color: '#71767b'
  }
}

function EventsChart({ data }) {
  if (!data || data.length === 0) {
    return <div style={styles.noData}>No data available</div>
  }

  // Format dates for display
  const chartData = data.map(d => ({
    ...d,
    displayDate: new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  }))

  return (
    <ResponsiveContainer width="100%" height={250}>
      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="colorEvents" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#1d9bf0" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#1d9bf0" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="displayDate"
          stroke="#71767b"
          tick={{ fill: '#71767b', fontSize: 12 }}
          axisLine={{ stroke: '#2f3336' }}
          tickLine={false}
        />
        <YAxis
          stroke="#71767b"
          tick={{ fill: '#71767b', fontSize: 12 }}
          axisLine={{ stroke: '#2f3336' }}
          tickLine={false}
          width={40}
        />
        <Tooltip
          contentStyle={{
            background: '#16181c',
            border: '1px solid #2f3336',
            borderRadius: '8px',
            color: '#e7e9ea'
          }}
          labelStyle={{ color: '#71767b' }}
        />
        <Area
          type="monotone"
          dataKey="count"
          stroke="#1d9bf0"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorEvents)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default EventsChart
