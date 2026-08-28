import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Sidebar from './components/Sidebar.jsx'
import DaemonGate from './components/DaemonGate.jsx'
import Overview from './pages/Overview.jsx'
import Projects from './pages/Projects.jsx'
import ProjectDetail from './pages/ProjectDetail.jsx'
import SessionDetail from './pages/SessionDetail.jsx'
import PromptDetail from './pages/PromptDetail.jsx'

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-neutral-900 text-neutral-100">
        <Sidebar />
        <main className="flex-1 p-6">
          <DaemonGate>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:path" element={<ProjectDetail />} />
              <Route path="/sessions/:id" element={<SessionDetail />} />
              <Route path="/prompts/:id" element={<PromptDetail />} />
            </Routes>
          </DaemonGate>
        </main>
      </div>
    </BrowserRouter>
  )
}
