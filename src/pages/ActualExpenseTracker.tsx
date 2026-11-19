import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Plus, Receipt, Trash2 } from 'lucide-react';
import { AppLayout } from '../components/AppLayout';
import { useTripContext } from '../context/TripContext';
import { ExpenseBucket } from '../types/trip';
import { formatINR } from '../utils/scheduleUtils';

const EXPENSE_CATEGORIES: ExpenseBucket[] = ['Food', 'Attraction', 'Transport', 'Leisure'];

export const ActualExpenseTracker: React.FC = () => {
  const {
    activeTrip,
    activeTripMetrics,
    addActualExpense,
    updateActualExpense,
    deleteActualExpense,
  } = useTripContext();

  const [itemName, setItemName] = useState('');
  const [itemAmount, setItemAmount] = useState('');
  const [itemDay, setItemDay] = useState(1);
  const [itemCategory, setItemCategory] = useState<ExpenseBucket>('Food');
  const [itemNotes, setItemNotes] = useState('');
  const [filterDay, setFilterDay] = useState<number | 'all'>('all');
  const [chartView, setChartView] = useState<'category' | 'day'>('category');
  const [formError, setFormError] = useState('');

  const actualExpenses = activeTrip?.actualExpenses || [];

  const filteredExpenses = useMemo(() => {
    if (filterDay === 'all') return actualExpenses;
    return actualExpenses.filter((e) => e.day === filterDay);
  }, [actualExpenses, filterDay]);

  const totalActualSpent = useMemo(
    () => actualExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    [actualExpenses]
  );

  const filteredActualTotal = useMemo(
    () => filteredExpenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0),
    [filteredExpenses]
  );

  const actualByCategory = useMemo(() => {
    const totals: Record<ExpenseBucket, number> = {
      Food: 0,
      Attraction: 0,
      Transport: 0,
      Leisure: 0,
    };
    for (const exp of actualExpenses) {
      const cat = exp.category || 'Leisure';
      totals[cat] = (totals[cat] || 0) + (Number(exp.amount) || 0);
    }
    return totals;
  }, [actualExpenses]);

  const actualByDay = useMemo(() => {
    const totals = new Map<number, number>();
    for (const exp of actualExpenses) {
      const d = exp.day || 1;
      totals.set(d, (totals.get(d) || 0) + (Number(exp.amount) || 0));
    }
    return totals;
  }, [actualExpenses]);

  const plannedVsActualData = useMemo(() => {
    if (!activeTrip) return [];
    if (chartView === 'day') {
      return Array.from({ length: activeTrip.daysCount }, (_, idx) => {
        const dayNum = idx + 1;
        return {
          name: `Day ${dayNum}`,
          'Planned Budget': activeTrip.budget.daily || 0,
          'Actual Expense': actualByDay.get(dayNum) || 0,
        };
      });
    }

    const leisurePlanned = Math.max(
      0,
      activeTrip.budget.total -
        activeTrip.budget.food -
        activeTrip.budget.attraction -
        activeTrip.budget.transport
    );

    return [
      {
        name: 'Food',
        'Planned Budget': activeTrip.budget.food,
        'Actual Expense': actualByCategory.Food,
      },
      {
        name: 'Attraction',
        'Planned Budget': activeTrip.budget.attraction,
        'Actual Expense': actualByCategory.Attraction,
      },
      {
        name: 'Transport',
        'Planned Budget': activeTrip.budget.transport,
        'Actual Expense': actualByCategory.Transport,
      },
      {
        name: 'Leisure',
        'Planned Budget': leisurePlanned,
        'Actual Expense': actualByCategory.Leisure,
      },
    ];
  }, [activeTrip, chartView, actualByCategory, actualByDay]);

  const estimatedVsActualData = useMemo(() => {
    if (!activeTrip || !activeTripMetrics) return [];
    if (chartView === 'day') {
      return activeTripMetrics.dayMetrics.map((dm) => ({
        name: `Day ${dm.dayNumber}`,
        'Estimated Cost': dm.totalExpense,
        'Actual Expense': actualByDay.get(dm.dayNumber) || 0,
      }));
    }

    return [
      {
        name: 'Food',
        'Estimated Cost': activeTripMetrics.categoryTotals.Food,
        'Actual Expense': actualByCategory.Food,
      },
      {
        name: 'Attraction',
        'Estimated Cost': activeTripMetrics.categoryTotals.Attraction,
        'Actual Expense': actualByCategory.Attraction,
      },
      {
        name: 'Transport',
        'Estimated Cost': activeTripMetrics.categoryTotals.Transport,
        'Actual Expense': actualByCategory.Transport,
      },
      {
        name: 'Leisure',
        'Estimated Cost': activeTripMetrics.categoryTotals.Leisure,
        'Actual Expense': actualByCategory.Leisure,
      },
    ];
  }, [activeTrip, activeTripMetrics, chartView, actualByCategory, actualByDay]);

  if (!activeTrip || !activeTripMetrics) {
    return (
      <AppLayout title="Expense Tracker">
        <div className="bg-white rounded-2xl border border-[#252B28]/10 p-10 text-center text-sm text-[#5A645F]">
          Create or select a trip to track actual expenses during your journey.
        </div>
      </AppLayout>
    );
  }

  const estimatedTotal = activeTripMetrics.totalEstimatedExpense;
  const varianceFromEstimate = estimatedTotal - totalActualSpent;
  const remainingFromBudget = activeTrip.budget.total - totalActualSpent;

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const trimmedName = itemName.trim();
    const parsedAmount = Number(itemAmount);

    if (!trimmedName) {
      setFormError('Please enter what you spent on (for example, Breakfast).');
      return;
    }
    if (itemAmount === '' || Number.isNaN(parsedAmount) || parsedAmount < 0) {
      setFormError('Please enter a valid amount in INR.');
      return;
    }

    addActualExpense({
      name: trimmedName,
      amount: parsedAmount,
      day: itemDay,
      category: itemCategory,
      notes: itemNotes,
    });

    setItemName('');
    setItemAmount('');
    setItemNotes('');
  };

  return (
    <AppLayout
      title="Expense Tracker"
      subtitle={`Log real on-trip spending for ${activeTrip.name} and compare against planned budget & estimated costs`}
    >
      <div className="space-y-6">
        {/* Top Comparison Summary Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="bg-[#174B3A] text-white rounded-2xl p-5">
            <div className="text-xs text-white/75">Total Actual Spent</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums">
              {formatINR(totalActualSpent)}
            </div>
            <div className="mt-1 text-[11px] text-white/75 font-mono tabular-nums">
              {actualExpenses.length} logged {actualExpenses.length === 1 ? 'item' : 'items'}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-5">
            <div className="text-xs text-[#5A645F]">Estimated Itinerary Total</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-[#252B28] tabular-nums">
              {formatINR(estimatedTotal)}
            </div>
            <div className="mt-1 text-[11px] text-[#5A645F]">
              From scheduled activities
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-[#252B28]/10 p-5">
            <div className="text-xs text-[#5A645F]">Estimate vs. Actual</div>
            <div
              className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${
                varianceFromEstimate >= 0 ? 'text-[#174B3A]' : 'text-red-700'
              }`}
            >
              {varianceFromEstimate >= 0
                ? `${formatINR(varianceFromEstimate)}`
                : `+${formatINR(Math.abs(varianceFromEstimate))}`}
            </div>
            <div className="mt-1 text-[11px] text-[#5A645F]">
              {varianceFromEstimate >= 0 ? 'Under estimated spend' : 'Above estimated spend'}
            </div>
          </div>

          <div
            className={`rounded-2xl border p-5 ${
              remainingFromBudget < 0
                ? 'bg-red-50 border-red-200'
                : 'bg-[#F8F5EC] border-[#252B28]/10'
            }`}
          >
            <div className="text-xs text-[#5A645F]">Actual Budget Remaining</div>
            <div
              className={`mt-1.5 font-mono text-2xl font-semibold tabular-nums ${
                remainingFromBudget < 0 ? 'text-red-700' : 'text-[#174B3A]'
              }`}
            >
              {formatINR(remainingFromBudget)}
            </div>
            <div className="mt-1 text-[11px] text-[#5A645F] font-mono tabular-nums">
              Trip budget cap: {formatINR(activeTrip.budget.total)}
            </div>
          </div>
        </section>

        {/* Two Comparison Graphs: Planned Budget vs Actual & Estimated Cost vs Actual */}
        <section className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#252B28]">
                Spending Comparison Charts
              </h2>
              <p className="text-xs text-[#5A645F]">
                Live visual comparison between your planned budget, estimated itinerary cost, and actual spending
              </p>
            </div>

            <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F8F5EC] border border-[#252B28]/10 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setChartView('category')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  chartView === 'category'
                    ? 'bg-white text-[#174B3A] shadow-sm'
                    : 'text-[#5A645F] hover:text-[#252B28]'
                }`}
              >
                By Category
              </button>
              <button
                type="button"
                onClick={() => setChartView('day')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                  chartView === 'day'
                    ? 'bg-white text-[#174B3A] shadow-sm'
                    : 'text-[#5A645F] hover:text-[#252B28]'
                }`}
              >
                By Day
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Graph 1: Planned Budget vs Actual Expense */}
            <div className="bg-white rounded-2xl border border-[#252B28]/10 p-6">
              <div className="flex items-start justify-between gap-2 mb-4">
                <div>
                  <h3 className="font-display text-lg font-semibold text-[#252B28]">
                    Planned Budget vs. Actual Expense
                  </h3>
                  <p className="text-xs text-[#5A645F] font-mono tabular-nums mt-0.5">
                    Planned: {formatINR(activeTrip.budget.total)} · Actual: {formatINR(totalActualSpent)}
                  </p>
                </div>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={plannedVsActualData}
                    margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E8E4D9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#5A645F' }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#5A645F' }}
                      tickFormatter={(v) => `₹${v}`}
                    />
                    <Tooltip
                      formatter={(value) => formatINR(Number(value) || 0)}
                      contentStyle={{
                        backgroundColor: '#FFFFFF',
                        borderColor: '#E2DFD5',
                        borderRadius: '12px',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Bar
                      dataKey="Planned Budget"
                      fill="#D8AC55"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={36}
                    />
                    <Bar
                      dataKey="Actual Expense"
                      fill="#174B3A"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Graph 2: Estimated Cost vs Actual Expense */}
            <div className="bg-white rounded-2xl border border-[#252B28]/10 p-6">
              <div className="flex items-start justify-between gap-2 mb-4">
                <div>
                  <h3 className="font-display text-lg font-semibold text-[#252B28]">
                    Estimated Cost vs. Actual Expense
                  </h3>
                  <p className="text-xs text-[#5A645F] font-mono tabular-nums mt-0.5">
                    Estimated: {formatINR(estimatedTotal)} · Actual: {formatINR(totalActualSpent)}
                  </p>
                </div>
              </div>
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={estimatedVsActualData}
                    margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#E8E4D9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#5A645F' }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#5A645F' }}
                      tickFormatter={(v) => `₹${v}`}
                    />
                    <Tooltip
                      formatter={(value) => formatINR(Number(value) || 0)}
                      contentStyle={{
                        backgroundColor: '#FFFFFF',
                        borderColor: '#E2DFD5',
                        borderRadius: '12px',
                        fontSize: '12px',
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: '12px' }} />
                    <Bar
                      dataKey="Estimated Cost"
                      fill="#5A7D95"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={36}
                    />
                    <Bar
                      dataKey="Actual Expense"
                      fill="#174B3A"
                      radius={[6, 6, 0, 0]}
                      maxBarSize={36}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </section>

        {/* Add Actual Expense Form */}
        <section className="bg-white rounded-2xl border border-[#252B28]/10 p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#252B28]">
                Add Actual Expense Item
              </h2>
              <p className="text-xs text-[#5A645F] mt-0.5">
                Enter what you spent on during the trip (e.g. Breakfast, Taxi, Entry Ticket) and the exact amount paid.
              </p>
            </div>
          </div>

          {formError && (
            <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs font-medium text-red-700">
              {formError}
            </div>
          )}

          <form onSubmit={handleAddItem} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-4">
              <label htmlFor="actual-item-name" className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Item / Activity Name
              </label>
              <input
                id="actual-item-name"
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="e.g., Breakfast, Auto to Fort, Coffee"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="actual-item-amount" className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Amount (INR)
              </label>
              <input
                id="actual-item-amount"
                type="number"
                min={0}
                step="1"
                value={itemAmount}
                onChange={(e) => setItemAmount(e.target.value)}
                placeholder="e.g., 350"
                className="w-full px-3.5 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="actual-item-day" className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Day
              </label>
              <select
                id="actual-item-day"
                value={itemDay}
                onChange={(e) => setItemDay(Number(e.target.value))}
                className="w-full px-3 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm font-mono tabular-nums focus:outline-none focus:border-[#174B3A]"
              >
                {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    Day {d}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="actual-item-category" className="block text-xs font-semibold text-[#252B28] mb-1.5">
                Category
              </label>
              <select
                id="actual-item-category"
                value={itemCategory}
                onChange={(e) => setItemCategory(e.target.value as ExpenseBucket)}
                className="w-full px-3 py-2.5 rounded-xl border border-[#252B28]/15 bg-[#FCFBF7] text-sm focus:outline-none focus:border-[#174B3A]"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#174B3A] text-white text-sm font-semibold hover:bg-[#123B2D] transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>Add Item</span>
              </button>
            </div>

            <div className="md:col-span-12">
              <input
                type="text"
                value={itemNotes}
                onChange={(e) => setItemNotes(e.target.value)}
                placeholder="Optional note (e.g., Paid via UPI at Café Morning)"
                className="w-full px-3.5 py-2 rounded-xl border border-[#252B28]/12 bg-[#FCFBF7] text-xs focus:outline-none focus:border-[#174B3A]"
              />
            </div>
          </form>
        </section>

        {/* Actual Expenses List & Running Total Footer */}
        <section className="bg-white rounded-2xl border border-[#252B28]/10 overflow-hidden">
          <div className="p-5 border-b border-[#252B28]/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg font-semibold text-[#252B28]">
                Logged Actual Spending
              </h2>
              <p className="text-xs text-[#5A645F]">
                Edit any item name or amount inline. The total at the bottom updates automatically.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={filterDay}
                onChange={(e) =>
                  setFilterDay(e.target.value === 'all' ? 'all' : Number(e.target.value))
                }
                aria-label="Filter actual expenses by day"
                className="px-3 py-1.5 rounded-lg border border-[#252B28]/15 bg-[#FCFBF7] text-xs font-medium"
              >
                <option value="all">All Days</option>
                {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    Day {d}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {filteredExpenses.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-11 h-11 rounded-2xl bg-[#F8F5EC] text-[#174B3A] flex items-center justify-center mx-auto mb-3">
                <Receipt className="w-5 h-5" />
              </div>
              <h3 className="font-display text-base font-semibold text-[#252B28]">
                No actual expenses recorded yet
              </h3>
              <p className="mt-1 text-xs text-[#5A645F] max-w-sm mx-auto">
                Add items like Breakfast, Local Transport, or Tickets above to track your real trip total below.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#252B28]/10 bg-[#FCFBF7] text-[11px] font-semibold text-[#5A645F]">
                    <th className="py-3 px-5">Day</th>
                    <th className="py-3 px-4">Item Name</th>
                    <th className="py-3 px-4">Category</th>
                    <th className="py-3 px-4 text-right">Amount Spent (INR)</th>
                    <th className="py-3 px-5 text-right">Remove</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#252B28]/8 text-sm">
                  {filteredExpenses.map((exp) => (
                    <tr key={exp.id} className="hover:bg-[#FCFBF7] transition-colors">
                      <td className="py-3 px-5">
                        <select
                          value={exp.day}
                          onChange={(e) =>
                            updateActualExpense(exp.id, { day: Number(e.target.value) })
                          }
                          aria-label={`Day for ${exp.name}`}
                          className="px-2 py-1 rounded-lg border border-[#252B28]/12 bg-[#FCFBF7] font-mono text-xs font-semibold text-[#174B3A] tabular-nums"
                        >
                          {Array.from({ length: activeTrip.daysCount }, (_, i) => i + 1).map(
                            (d) => (
                              <option key={d} value={d}>
                                Day {d}
                              </option>
                            )
                          )}
                        </select>
                      </td>
                      <td className="py-3 px-4">
                        <input
                          type="text"
                          value={exp.name}
                          onChange={(e) =>
                            updateActualExpense(exp.id, { name: e.target.value })
                          }
                          aria-label={`Name for ${exp.name}`}
                          className="w-full min-w-[180px] px-2.5 py-1.5 rounded-lg border border-transparent hover:border-[#252B28]/15 focus:border-[#174B3A] focus:bg-[#FCFBF7] bg-transparent font-medium text-[#252B28] focus:outline-none"
                        />
                        {exp.notes && (
                          <div className="px-2.5 text-[11px] text-[#5A645F]">{exp.notes}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <select
                          value={exp.category}
                          onChange={(e) =>
                            updateActualExpense(exp.id, {
                              category: e.target.value as ExpenseBucket,
                            })
                          }
                          aria-label={`Category for ${exp.name}`}
                          className="px-2.5 py-1.5 rounded-lg border border-[#252B28]/12 bg-[#FCFBF7] text-xs text-[#5A645F]"
                        >
                          {EXPENSE_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={exp.amount}
                          onChange={(e) =>
                            updateActualExpense(exp.id, {
                              amount: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          aria-label={`Amount for ${exp.name}`}
                          className="w-32 text-right px-3 py-1.5 rounded-lg border border-[#252B28]/15 bg-[#FCFBF7] font-mono text-sm font-semibold text-[#252B28] tabular-nums focus:outline-none focus:border-[#174B3A]"
                        />
                      </td>
                      <td className="py-3 px-5 text-right">
                        <button
                          type="button"
                          onClick={() => deleteActualExpense(exp.id)}
                          className="p-1.5 rounded-lg text-[#5A645F] hover:text-red-700 hover:bg-red-50 transition-colors"
                          aria-label={`Delete ${exp.name}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#252B28]/15 bg-[#F8F5EC]">
                    <td colSpan={3} className="py-4 px-5">
                      <div className="font-display text-base font-semibold text-[#252B28]">
                        {filterDay === 'all'
                          ? 'Total Actual Money Spent'
                          : `Day ${filterDay} Actual Total`}
                      </div>
                      <div className="text-xs text-[#5A645F]">
                        {filteredExpenses.length}{' '}
                        {filteredExpenses.length === 1 ? 'item' : 'items'}
                        {filterDay !== 'all' &&
                          ` · Overall trip actual spent: ${formatINR(totalActualSpent)}`}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="font-mono text-xl font-bold text-[#174B3A] tabular-nums">
                        {formatINR(filteredActualTotal)}
                      </div>
                    </td>
                    <td className="py-4 px-5" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
};
