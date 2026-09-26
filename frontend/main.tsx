import React from 'react';
import ReactDOM from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './index.css';
import { CircuitLab } from './CircuitLab';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CircuitLab />
  </React.StrictMode>
);
