import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { recordRendererError } from '@/lib/platform'
import { applyCachedTheme } from '@/lib/theme'
import { App } from './App'

// Uncaught errors are collected for scripts/snap.mjs and the e2e suite.
window.__datagrippeErrors ??= []
window.addEventListener('error', (event) => recordRendererError(event.error ?? event.message, 'window'))
window.addEventListener('unhandledrejection', (event) => recordRendererError(event.reason, 'promise'))

applyCachedTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root, {
  onUncaughtError: (error) => recordRendererError(error, 'react'),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
