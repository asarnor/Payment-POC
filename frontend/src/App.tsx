import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { PaymentsList } from './pages/PaymentsList';
import { PaymentDetail } from './pages/PaymentDetail';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <header className="app-header">
          <h1 className="app-title">Payment Dashboard</h1>
        </header>
        <main className="app-main">
          <Routes>
            <Route path="/" element={<PaymentsList />} />
            <Route path="/payments/:id" element={<PaymentDetail />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
