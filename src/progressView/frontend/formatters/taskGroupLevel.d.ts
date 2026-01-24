export const TaskGroupLevel: {
  ROOT: {
    name: string;
    formatTime: (date: Date, formatter: Intl.DateTimeFormat) => string;
    showTitle: boolean;
    headerOrder: string;
    cssClass: string | null;
  };
  NESTED: {
    name: string;
    formatTime: (date: Date, formatter: Intl.DateTimeFormat) => string;
    showTitle: boolean;
    headerOrder: string;
    cssClass: string | null;
  };
};
