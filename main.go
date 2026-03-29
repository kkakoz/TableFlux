package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	store, err := NewDataStore("TableFlux")
	if err != nil {
		log.Fatal(err)
	}
	secretSvc := NewSecretService(store)
	workspaceSvc := NewWorkspaceService(store, secretSvc)
	dbSvc := NewDatabaseService(store, secretSvc)
	studioSvc := NewStudioWindowService(store)
	taskSvc := NewTaskService(store)

	app := application.New(application.Options{
		Name:        "TableFlux",
		Description: "TableFlux desktop database client",
		Services: []application.Service{
			application.NewService(secretSvc),
			application.NewService(workspaceSvc),
			application.NewService(dbSvc),
			application.NewService(studioSvc),
			application.NewService(taskSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "TableFlux",
		Width:            1280,
		Height:           860,
		MinWidth:         1024,
		MinHeight:        680,
		BackgroundColour: application.NewRGB(11, 17, 26),
		URL:              "/",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
