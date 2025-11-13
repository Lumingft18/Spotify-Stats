import { useState, useRef, DragEvent } from 'react';

interface FileUploadProps {
  onFileSelect: (file: File) => void;
  isProcessing: boolean;
  progress: string;
  error: string | null;
}

export function FileUpload({ onFileSelect, isProcessing, progress, error }: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.zip')) {
      onFileSelect(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  if (isProcessing) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-12 border border-gray-700 shadow-2xl">
          <div className="text-center">
            <div className="relative inline-block mb-6">
              <div className="animate-spin rounded-full h-20 w-20 border-4 border-gray-700 border-t-green-500"></div>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-3xl">🎵</span>
              </div>
            </div>
            <h3 className="text-2xl font-bold text-white mb-2">Elaborazione in corso...</h3>
            <p className="text-gray-400 mb-4">{progress || 'Caricamento dati...'}</p>
            <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
              <div
                className="bg-gradient-to-r from-green-500 to-green-600 h-full transition-all duration-300"
                style={{
                  width: progress.includes('finished')
                    ? '100%'
                    : progress.match(/\d+/)?.[0]
                    ? `${(parseInt(progress.match(/\d+/)?.[0] || '0') / 9) * 100}%`
                    : '10%',
                }}
              />
            </div>
            <p className="text-sm text-gray-500 mt-4">Questo può richiedere uno o due minuti</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-12 border border-gray-700 shadow-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 mb-6">
            <span className="text-4xl">📁</span>
          </div>
          <h2 className="text-3xl font-bold text-white mb-3">Carica i tuoi dati Spotify</h2>
          <p className="text-gray-400 text-lg max-w-2xl mx-auto">
            Analizza le tue statistiche di ascolto Spotify in modo dettagliato e personalizzato.
            I tuoi dati vengono elaborati solo nel browser e non lasciano mai il tuo computer.
          </p>
        </div>

        <div className="mb-6">
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700">
            <h3 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
              <span>ℹ️</span> Come ottenere i tuoi dati
            </h3>
            <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
              <li>
                Vai alla{' '}
                <a
                  href="https://www.spotify.com/us/account/privacy/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-500 hover:text-green-400 underline"
                >
                  pagina account Spotify
                </a>
              </li>
              <li>Richiedi la tua "Extended streaming history"</li>
              <li>Una volta scaricata, caricala qui</li>
            </ol>
          </div>
        </div>

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handleClick}
          className={`
            border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all duration-300
            ${
              isDragging
                ? 'border-green-500 bg-green-500/10 scale-105'
                : 'border-gray-600 hover:border-green-500 hover:bg-gray-800/50'
            }
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleFileInput}
            className="hidden"
          />
          <div className="space-y-4">
            <div className="text-6xl mb-4">
              {isDragging ? '📦' : '📁'}
            </div>
            <div>
              <p className="text-xl font-semibold text-white mb-2">
                {isDragging ? 'Rilascia il file qui' : 'Trascina il file ZIP qui'}
              </p>
              <p className="text-gray-400">oppure</p>
              <button className="mt-4 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white font-semibold py-3 px-8 rounded-lg transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105">
                Sfoglia file
              </button>
            </div>
            <p className="text-sm text-gray-500">Solo file .zip</p>
          </div>
        </div>

        {error && (
          <div className="mt-6 bg-red-900/30 border border-red-700 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <span className="text-xl">⚠️</span>
              <div>
                <p className="text-red-200 font-semibold mb-1">Errore</p>
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

