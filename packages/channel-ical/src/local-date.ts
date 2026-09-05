function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function dayNumber(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthOfYear = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthOfYear + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra;
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const current = dayNumber(year, month, day);
  return current >= dayNumber(year, month, 1) && current < dayNumber(nextYear, nextMonth, 1);
}

export function intervalNights(arrival: string, departure: string): number {
  return (
    dayNumber(
      Number(departure.slice(0, 4)),
      Number(departure.slice(5, 7)),
      Number(departure.slice(8, 10)),
    ) -
    dayNumber(
      Number(arrival.slice(0, 4)),
      Number(arrival.slice(5, 7)),
      Number(arrival.slice(8, 10)),
    )
  );
}
