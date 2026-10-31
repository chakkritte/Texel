import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import Login from './pages/Login'
import Register from './pages/Register'
import Projects from './pages/Projects'
import Editor from './pages/Editor'
import Admin from './pages/Admin'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth()
  if (!ready) return <div className="p-8">Loading…</div>
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  const { ready, bootstrap, user } = useAuth()

  useEffect(() => {
    bootstrap()
  }, [bootstrap])

  if (!ready) return <div className="p-8 text-zinc-500">Loading…</div>

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <Register />} />
      <Route
        path="/"
        element={
          <Protected>
            <Projects />
          </Protected>
        }
      />
      <Route
        path="/projects/:id"
        element={
          <Protected>
            <Editor />
          </Protected>
        }
      />
      <Route
        path="/admin"
        element={
          <Protected>
            <Admin />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
