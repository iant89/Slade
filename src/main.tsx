import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Highlight.js theme driven by data-theme via CSS custom props is nice, but the
// hljs colorways ship as real stylesheets — import both and scope by wrapper.
import 'highlight.js/styles/github-dark.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
