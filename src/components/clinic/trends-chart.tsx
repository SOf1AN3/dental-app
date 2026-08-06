"use client"

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts"

interface TrendsChartProps {
  data: { month: string; patients: number; appointments: number; revenue: number }[]
}

export function TrendsChart({ data }: TrendsChartProps) {
  if (!data || data.length === 0) {
    return <p className="text-sm text-cool-400 text-center py-8">Aucune donnée de tendances</p>
  }

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="#9ca3af" />
          <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="appointments" stroke="#1e2a5a" strokeWidth={2} name="RDV" />
          <Line type="monotone" dataKey="patients" stroke="#0ea5e9" strokeWidth={2} name="Patients" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
