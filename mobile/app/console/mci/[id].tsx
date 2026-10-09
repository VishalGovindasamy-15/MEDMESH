import { useState, useEffect, useCallback, useMemo } from 'react';
import { StyleSheet, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { api, ApiError } from '../../../src/api/client';
import { Incident, Ambulance, ShortlistCandidate, District } from '../../../src/api/types';
import { useAuth } from '../../../src/state/AuthProvider';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { space, radius } from '../../../src/theme/tokens';
import { AppShell } from '../../../src/ui/Shell';
import {
  Banner,
  Body,
  Button,
  Card,
  Row,
  Small,
  Stack,
  Title,
} from '../../../src/ui';
import { VehicleField, FacilityField, PickerDistrict, PickerFacility } from '../../../src/components/Selectors';

export default function MCIReviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const incidentId = Number(id);
  const router = useRouter();
  const { token } = useAuth();
  const { t } = useTheme();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [plan, setPlan] = useState<any[]>([]);
  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [hospitals, setHospitals] = useState<ShortlistCandidate[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const [inc, mci, dists] = await Promise.all([
          api.get<Incident>(`/incidents/${incidentId}`, { token }),
          api.get<any>(`/incidents/${incidentId}/mci-plan`, { token }),
          api.get<{ results: District[] }>('/hospitals/districts', { token })
        ]);
        setIncident(inc);
        setPlan(mci.plan);
        setAmbulances(mci.available_ambulances);
        setHospitals(mci.shortlist);
        setDistricts(dists.results);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load MCI plan');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [incidentId, token]);

  const commitMCI = async () => {
    setSubmitting(true);
    try {
      await api.post(`/incidents/${incidentId}/mci-commit`, { assignments: plan }, { token });
      router.replace('/console'); // Redirect to fleet panel
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to dispatch MCI');
      setSubmitting(false);
    }
  };

  const updateAssignment = (index: number, key: 'ambulance_id' | 'hospital_id', value: number) => {
    setPlan(prev => {
      const copy = [...prev];
      copy[index] = { ...copy[index], [key]: value };
      return copy;
    });
  };

  const districtOptions: PickerDistrict[] = useMemo(() => 
    districts.map(d => ({
      id: d.id,
      name: d.name,
      name_ta: d.name_ta,
      headquarters: null,
      facilities: d.hospital_count ?? 0,
    })),
  [districts]);

  const facilityOptions: PickerFacility[] = useMemo(() => 
    hospitals.map(h => ({
      id: h.hospital_id,
      name: h.name,
      short_name: h.short_name,
      district_id: h.district_id,
      type_label: h.eligible ? 'Capable' : 'Not Capable'
    })),
  [hospitals]);

  if (loading) {
    return <AppShell title="Loading MCI Plan..." scroll={false}><View style={{ padding: space.xl }}><Body>Loading...</Body></View></AppShell>;
  }

  return (
    <AppShell title={`Mass Casualty Incident: ${incident?.reference || id}`} maxWidth={800} scroll={false}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.xl }}>
        
        <Banner
          tone="critical"
          icon="alert"
          title={`MCI Mode Active: ${incident?.scene?.casualty_count} Casualties`}
          body="The system has drafted a distribution plan to prevent overwhelming a single ER. You can manually override any of the assignments below before committing the dispatch."
        />

        {error ? (
          <Banner tone="critical" icon="x" title="Error" body={error} />
        ) : null}

        <Stack gap="md">
          {plan.map((assignment, idx) => {
            return (
              <Card key={idx} style={{ gap: space.md, borderColor: t.status.critical.base, borderWidth: 2 }}>
                <Row align="center" justify="space-between">
                  <Title>Patient {idx + 1}</Title>
                  <Small muted>Routing to {hospitals.find(h => h.hospital_id === assignment.hospital_id)?.short_name}</Small>
                </Row>
                
                <Row gap="lg" style={{ flexWrap: 'wrap' }}>
                  <Stack style={{ flex: 1, minWidth: 200, zIndex: 100 - idx }}>
                    <VehicleField
                      label="Assigned Unit"
                      vehicles={ambulances}
                      districts={districtOptions}
                      value={assignment.ambulance_id}
                      onChange={(val) => val && updateAssignment(idx, 'ambulance_id', val)}
                    />
                  </Stack>

                  <Stack style={{ flex: 1, minWidth: 200, zIndex: 100 - idx }}>
                    <FacilityField
                      label="Destination Hospital"
                      facilities={facilityOptions}
                      districts={districtOptions}
                      value={assignment.hospital_id}
                      onChange={(val) => val && updateAssignment(idx, 'hospital_id', val)}
                    />
                  </Stack>
                </Row>
              </Card>
            );
          })}
        </Stack>

        <Button
          label={`Confirm & Dispatch All ${plan.length} Units`}
          variant="danger"
          icon="siren"
          loading={submitting}
          onPress={commitMCI}
          size="lg"
        />

      </ScrollView>
    </AppShell>
  );
}
