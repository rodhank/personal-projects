import SwiftUI

struct BrowserView: View {
    @StateObject private var model = BrowserModel()
    @FocusState private var addressFocused: Bool
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if model.isLoading {
                ProgressView(value: model.progress).progressViewStyle(.linear).frame(height: 2)
            }
            if let host = model.lidarHost {
                lidarBanner(host)
            }
            WebContainer(view: model.container)
                .ignoresSafeArea(edges: .bottom)
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView(store: PermissionStore.shared, lidarSupported: model.container.bridge.lidarSupported)
        }
        .onChange(of: addressFocused) { focused in
            model.isEditingAddress = focused
        }
        .onChange(of: scenePhase) { phase in
            if phase == .active { model.appBecameActive() }
        }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            Button(action: model.back) { Image(systemName: "chevron.backward") }
                .disabled(!model.canGoBack)
            Button(action: model.forward) { Image(systemName: "chevron.forward") }
                .disabled(!model.canGoForward)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundColor(.secondary).font(.footnote)
                TextField("Search or enter website", text: $model.addressText)
                    .focused($addressFocused)
                    .keyboardType(.webSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit {
                        model.go()
                        addressFocused = false
                    }
                Button(action: model.reloadOrStop) {
                    Image(systemName: model.isLoading ? "xmark" : "arrow.clockwise").font(.footnote)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color(.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Menu {
                Button { model.home() } label: { Label("Home", systemImage: "house") }
                Section("LiDAR pages") {
                    ForEach(BrowserModel.examples) { item in
                        Button(item.title) { model.load(item.url) }
                    }
                }
                Button { model.showSettings = true } label: { Label("Site Permissions", systemImage: "hand.raised") }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
        .font(.body)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func lidarBanner(_ host: String) -> some View {
        HStack(spacing: 8) {
            Circle().fill(Color.red).frame(width: 8, height: 8)
            Text("LiDAR in use by \(host)").font(.footnote.weight(.semibold))
            Spacer()
            Button("Stop", action: model.stopLidar).font(.footnote.weight(.semibold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Color.red.opacity(0.15))
    }
}

/// Hosts the UIKit browser surface inside SwiftUI.
struct WebContainer: UIViewRepresentable {
    let view: WebContainerView
    func makeUIView(context: Context) -> WebContainerView { view }
    func updateUIView(_ uiView: WebContainerView, context: Context) {}
}
