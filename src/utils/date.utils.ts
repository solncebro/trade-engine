import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

export const createDate = (value?: string | number | Date): Date => {
  return dayjs(value).toDate();
};

export const formatTimestamp = (
  timestamp: number,
  isNeedDate: boolean = false
): string => {
  return dayjs(timestamp)
    .utc()
    .format(isNeedDate ? 'YYYY.MM.DD HH:mm:ss.SSS' : 'HH:mm:ss.SSS');
};

export const createHumanTimestamp = (
  value?: string | number | Date
): string => {
  return formatTimestamp(createDate(value).getTime());
};
