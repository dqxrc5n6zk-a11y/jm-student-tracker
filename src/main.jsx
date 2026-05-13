import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import MembershipCheckInApp from './components/MembershipCheckInApp.jsx'

const params = new URLSearchParams(window.location.search)
const rootElement = params.get('app') === 'members' || params.get('view') === 'members'
  ? <MembershipCheckInApp />
  : <App />

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {rootElement}
  </StrictMode>,
)
