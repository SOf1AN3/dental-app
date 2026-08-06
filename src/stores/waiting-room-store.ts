import { create } from "zustand";

interface WaitingRoomEntry {
  id: string;
  patientId: string;
  patientName: string;
  status: "waiting" | "called" | "in_treatment" | "completed" | "no_show";
  arrivedAt: Date;
  notes?: string;
}

interface WaitingRoomState {
  entries: WaitingRoomEntry[];
  isLoading: boolean;
  setEntries: (entries: WaitingRoomEntry[]) => void;
  updateEntry: (id: string, data: Partial<WaitingRoomEntry>) => void;
  setLoading: (loading: boolean) => void;
}

export const useWaitingRoomStore = create<WaitingRoomState>((set) => ({
  entries: [],
  isLoading: false,
  setEntries: (entries) => set({ entries }),
  updateEntry: (id, data) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.id === id ? { ...e, ...data } : e
      ),
    })),
  setLoading: (isLoading) => set({ isLoading }),
}));
