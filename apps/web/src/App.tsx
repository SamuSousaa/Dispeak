import { Route, Routes } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { LabP2pPage } from './pages/LabP2pPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/lab/p2p" element={<LabP2pPage />} />
    </Routes>
  );
}
