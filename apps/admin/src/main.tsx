import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import StudioApp from './studio/App';
import './styles.css';

// 보리 스튜디오 마운트. 이 호출이 없으면 index.html의 로딩 문구가 그대로 남는다.
const container = document.getElementById('root');
if (!container) throw new Error('#root element not found in admin index.html');
createRoot(container).render(<StrictMode><StudioApp /></StrictMode>);
