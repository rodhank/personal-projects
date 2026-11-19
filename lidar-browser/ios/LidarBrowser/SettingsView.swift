import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: PermissionStore
    let lidarSupported: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                Section {
                    if store.allowedOrigins.isEmpty {
                        Text("No websites have LiDAR access.").foregroundColor(.secondary)
                    }
                    ForEach(store.allowedOrigins, id: \.self) { origin in
                        Text(origin)
                    }
                    .onDelete { idx in
                        idx.map { store.allowedOrigins[$0] }.forEach(store.revoke)
                    }
                } header: {
                    Text("Websites allowed to use the LiDAR")
                } footer: {
                    Text("Swipe left to remove a site. It will ask again next time it wants depth data.")
                }
                if !store.allowedOrigins.isEmpty {
                    Section {
                        Button("Remove All", role: .destructive) { store.revokeAll() }
                    }
                }
                Section("This device") {
                    HStack {
                        Text("LiDAR scanner")
                        Spacer()
                        Text(lidarSupported ? "Available" : "Not available").foregroundColor(.secondary)
                    }
                }
                Section("For website developers") {
                    Text("Pages can use navigator.lidar, or standard WebXR 'immersive-ar' with the 'depth-sensing' feature. See API.md in the project.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Site Permissions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}
