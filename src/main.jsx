import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import { installPulseSync } from './lib/pulse-sync';

installPulseSync();

const root = createRoot(document.getElementById('root'));
root.render(<App />);
