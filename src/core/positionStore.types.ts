import type { MonitoredPosition, MonitoredPositionsDocument } from '../types/index';

interface PositionStore {
  loadMonitoredPositions(): Promise<MonitoredPositionsDocument>;
  saveMonitoredPosition(position: MonitoredPosition): Promise<void>;
  updateMonitoredPosition(positionId: string, partial: Partial<MonitoredPosition>): Promise<void>;
  deleteLegacyPositionFields(positionId: string, fieldNameList: string[]): Promise<void>;
  removeMonitoredPosition(positionId: string): Promise<void>;
}

export type { PositionStore };
