import { useState } from 'react';

export type PeriodType = 
  | 'total'
  | 'this_month'
  | 'last_3_months'
  | 'last_6_months'
  | 'last_9_months'
  | 'last_year'
  | 'custom';

interface PeriodFilterProps {
  onPeriodChange: (period: PeriodType, startDate?: Date, endDate?: Date) => void;
  disabled?: boolean;
}

export function PeriodFilter({ onPeriodChange, disabled = false }: PeriodFilterProps) {
  const [selectedPeriod, setSelectedPeriod] = useState<PeriodType>('total');
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  const handlePeriodSelect = (period: PeriodType) => {
    if (disabled) return;
    
    setSelectedPeriod(period);
    
    if (period === 'custom') {
      setShowCustomPicker(true);
    } else {
      setShowCustomPicker(false);
      if (period === 'total') {
        // Per "totale" non serve passare date
        onPeriodChange(period);
      } else {
        const { startDate, endDate } = getPeriodDates(period);
        onPeriodChange(period, startDate, endDate);
      }
    }
  };

  const handleCustomDateSubmit = () => {
    if (customStartDate && customEndDate) {
      const startDate = new Date(customStartDate);
      const endDate = new Date(customEndDate);
      
      if (startDate <= endDate) {
        onPeriodChange('custom', startDate, endDate);
        setShowCustomPicker(false);
      } else {
        alert('La data di inizio deve essere precedente alla data di fine');
      }
    }
  };

  const getPeriodDates = (period: PeriodType): { startDate: Date; endDate: Date } => {
    const today = new Date();
    let startDate: Date;
    let endDate: Date;

    switch (period) {
      case 'this_month':
        startDate = new Date(today.getFullYear(), today.getMonth(), 1);
        endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        break;
      case 'last_3_months':
        startDate = new Date(today.getFullYear(), today.getMonth() - 3, 1);
        endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        break;
      case 'last_6_months':
        startDate = new Date(today.getFullYear(), today.getMonth() - 6, 1);
        endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        break;
      case 'last_9_months':
        startDate = new Date(today.getFullYear(), today.getMonth() - 9, 1);
        endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        break;
      case 'last_year':
        // Anno scorso completo (dal 1 gennaio all'31 dicembre dell'anno precedente)
        startDate = new Date(today.getFullYear() - 1, 0, 1);
        endDate = new Date(today.getFullYear() - 1, 11, 31);
        break;
      case 'total':
      default:
        // Per "totale" useremo date molto lontane per includere tutto
        startDate = new Date(2000, 0, 1);
        endDate = new Date(2100, 11, 31);
        break;
    }

    return { startDate, endDate };
  };


  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-400 whitespace-nowrap">Periodo:</span>
        <div className="relative">
          <select
            value={selectedPeriod}
            onChange={(e) => handlePeriodSelect(e.target.value as PeriodType)}
            disabled={disabled}
            className="appearance-none bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 pr-8 text-white text-sm font-medium cursor-pointer hover:bg-gray-700 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <option value="total">Totale</option>
            <option value="this_month">Questo mese</option>
            <option value="last_3_months">Ultimi 3 mesi</option>
            <option value="last_6_months">Ultimi 6 mesi</option>
            <option value="last_9_months">Ultimi 9 mesi</option>
            <option value="last_year">Anno scorso</option>
            <option value="custom">Personalizzato</option>
          </select>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            <span className="text-gray-400">▼</span>
          </div>
        </div>
      </div>

      {showCustomPicker && (
        <div className="absolute top-full left-0 mt-2 bg-gray-800 border border-gray-700 rounded-lg p-4 shadow-xl z-50 min-w-[300px]">
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-gray-300 mb-2">Data inizio</label>
              <input
                type="date"
                value={customStartDate}
                onChange={(e) => setCustomStartDate(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-300 mb-2">Data fine</label>
              <input
                type="date"
                value={customEndDate}
                onChange={(e) => setCustomEndDate(e.target.value)}
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCustomDateSubmit}
                disabled={!customStartDate || !customEndDate}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium py-2 px-4 rounded-lg transition-colors"
              >
                Applica
              </button>
              <button
                onClick={() => {
                  setShowCustomPicker(false);
                  setCustomStartDate('');
                  setCustomEndDate('');
                  setSelectedPeriod('total');
                  onPeriodChange('total');
                }}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

