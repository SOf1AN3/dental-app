import { create } from "zustand";

interface ClinicState {
  activeClinicId: string | null;
  setActiveClinicId: (id: string) => void;
  clearActiveClinic: () => void;
}

export const useClinicStore = create<ClinicState>((set) => ({
  activeClinicId: null,
  setActiveClinicId: (id) => set({ activeClinicId: id }),
  clearActiveClinic: () => set({ activeClinicId: null }),
}));
