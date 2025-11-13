import { useState, useEffect, useMemo } from 'react';
import type { DataFrameData } from '../types';
import { formatValue } from '../utils/dataProcessing';

interface DataTableProps {
  title: string;
  data: DataFrameData;
  showRank?: boolean;
}

export function DataTable({ title, data, showRank = false }: DataTableProps) {
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [searchTerm, setSearchTerm] = useState('');

  const handleSort = (columnIndex: number) => {
    let newDirection: 'asc' | 'desc' = 'asc';
    
    if (sortColumn === columnIndex) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    }
    
    setSortColumn(columnIndex);
    setSortDirection(newDirection);
  };

  const filteredAndSortedData = useMemo(() => {
    let result = [...data.data];

    // Filter by search term
    if (searchTerm) {
      result = result.filter((row) =>
        row.some((cell) =>
          String(cell).toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    // Sort
    if (sortColumn !== null) {
      result.sort((a, b) => {
        const aVal = a[sortColumn];
        const bVal = b[sortColumn];
        
        if (typeof aVal === 'number' && typeof bVal === 'number') {
          return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
        }
        
        const aStr = String(aVal);
        const bStr = String(bVal);
        return sortDirection === 'asc' 
          ? aStr.localeCompare(bStr)
          : bStr.localeCompare(aStr);
      });
    }

    return result;
  }, [data.data, searchTerm, sortColumn, sortDirection]);
  
  useEffect(() => {
    setSortColumn(null);
    setSearchTerm('');
  }, [data]);

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <h3 className="text-2xl font-bold text-white">{title}</h3>
        <div className="relative">
          <input
            type="text"
            placeholder="Cerca..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full sm:w-64 pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <span className="absolute left-3 top-2.5 text-gray-400">🔍</span>
        </div>
      </div>

      <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl border border-gray-700 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-800/50 border-b border-gray-700">
                {showRank && (
                  <th className="px-6 py-4 text-left font-semibold text-gray-300 text-sm uppercase tracking-wider">
                    #
                  </th>
                )}
                {data.columns.map((col, idx) => (
                  <th
                    key={idx}
                    onClick={() => handleSort(idx)}
                    className="px-6 py-4 text-left font-semibold text-gray-300 text-sm uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors whitespace-nowrap"
                  >
                    <div className="flex items-center gap-2">
                      <span>{col}</span>
                      {sortColumn === idx && (
                        <span className="text-green-500">
                          {sortDirection === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-700">
              {filteredAndSortedData.length === 0 ? (
                <tr>
                  <td
                    colSpan={data.columns.length + (showRank ? 1 : 0)}
                    className="px-6 py-12 text-center text-gray-400"
                  >
                    Nessun risultato trovato
                  </td>
                </tr>
              ) : (
                filteredAndSortedData.map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="hover:bg-gray-800/50 transition-colors group"
                  >
                    {showRank && (
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <span className="text-gray-400 font-medium">{rowIdx + 1}</span>
                          {rowIdx < 3 && (
                            <span className="text-xl">
                              {rowIdx === 0 ? '🥇' : rowIdx === 1 ? '🥈' : '🥉'}
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    {row.map((cell, cellIdx) => {
                      const columnName = data.columns[cellIdx];
                      const formattedValue = formatValue(cell, columnName);
                      
                      if (typeof formattedValue === 'string' && formattedValue.startsWith('data:image')) {
                        return (
                          <td key={cellIdx} className="px-6 py-4">
                            <img src={formattedValue} alt="Monthly play count" className="h-12 rounded" />
                          </td>
                        );
                      }
                      
                      return (
                        <td key={cellIdx} className="px-6 py-4 text-gray-300 group-hover:text-white transition-colors">
                          {formattedValue}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filteredAndSortedData.length > 0 && (
          <div className="px-6 py-3 bg-gray-800/50 border-t border-gray-700 text-sm text-gray-400">
            Mostrando {filteredAndSortedData.length} di {data.data.length} risultati
          </div>
        )}
      </div>
    </div>
  );
}
