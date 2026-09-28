import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'

// Do NOT import an `highlight.js/styles/*.css` colorway here. Those ship
// unscoped `.hljs { color; background }` rules that land *after* this app's
// theme-aware palette in the cascade and win on equal specificity, which
// painted GitHub Dark text (#c9d1d9) onto the light code surface and made
// code illegible in the light theme. The `--syn-*` palette in global.css,
// scoped by [data-code-theme], is the only syntax theme.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
