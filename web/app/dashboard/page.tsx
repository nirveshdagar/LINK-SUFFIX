import { Suspense } from 'react'
import TrafficDashboard from '../../components/traffic-dashboard'
import EvidenceWorkspace from '../../components/evidence-workspace'
import './evidence.css'

export default function DashboardPage() {
  return <><TrafficDashboard /><Suspense fallback={null}><EvidenceWorkspace /></Suspense></>
}
