import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 主题初始化(渲染前执行避免闪白):手动选择优先,否则跟随系统
const savedTheme = localStorage.getItem('cfnote-theme')
if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark')
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
