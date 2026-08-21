import type { Metadata } from 'next'
import TrafficDashboard from '@/components/traffic-dashboard'

export const metadata: Metadata = {
  title: 'Traffic Armour | Harness Overview',
  description: 'Live traffic policy evaluation.',
}

export default function Page() {
  return <TrafficDashboard />
}
